//! fetch（T-17）を生成済みリポジトリに対して通す結合テスト。
//!
//! 進捗行のパースと放置警告の判定は `src/git/fetchprogress.rs` /
//! `src/git/ops.rs` のユニットテスト側で見る。ここで見るのは
//! 「**実物の git を相手にしても ref が増減する**」ことと、リモートの有無の判定。
//!
//! **fetch はリポジトリを書き換える**ので、テストごとに複製してから触る。
//! cargo は同じバイナリ内のテストを並列に走らせるため、実体を共有すると
//! `--prune` で消えた ref が別のテストから見えなくなる。

mod common;

use std::path::{Path, PathBuf};

use gitpeek_lib::git::exec::{self, Cancel};
use gitpeek_lib::git::ops::{self, FetchStatus};
use gitpeek_lib::git::repo;

use common::{fixtures, log};

/// 生成済みリポジトリを丸ごと複製して、その複製を返す。
fn working_copy(name: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let target = dir.path().join(name);
    copy_dir(&fixtures().join(name), &target);
    (dir, target)
}

/// `fetch-client` と**その上流も**複製し、上流を複製側へ向け直したものを返す。
///
/// 上流を共有したままにしてはいけない。中止の試験は git を kill するので、
/// **落とし損ねた子プロセスが上流のファイルを掴んだまま残る**ことがある。
/// Windows では掴まれたファイルを消せないので、次のテストバイナリが
/// `%TEMP%\gitpeek-test-repos` を作り直せずに落ちる（実際に一度落ちた）。
fn client_with_origin() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let origin = dir.path().join("fetch-origin.git");
    let client = dir.path().join("fetch-client");
    copy_dir(&fixtures().join("fetch-origin.git"), &origin);
    copy_dir(&fixtures().join("fetch-client"), &client);

    let url = origin.display().to_string();
    let output = exec::run(
        &log(),
        "git",
        Some(&client),
        &["remote", "set-url", "origin", &url],
    )
    .expect("remote set-url");
    assert!(output.ok(), "上流を複製側へ向け直せない: {}", output.stderr);

    (dir, client)
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("複製先を作る");
    for entry in std::fs::read_dir(from).expect("複製元を読む") {
        let entry = entry.expect("複製元の項目");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("種別").is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("ファイルの複製");
        }
    }
}

/// リモート追跡 ref の一覧。**テストコードからは git を呼んでよい**（CLAUDE.md §8）。
fn remote_refs(repo: &Path) -> Vec<String> {
    let output = exec::run(
        &log(),
        "git",
        Some(repo),
        &["for-each-ref", "--format=%(refname)", "refs/remotes"],
    )
    .expect("for-each-ref");
    let mut refs: Vec<String> = output
        .stdout_lossy()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    refs.sort();
    refs
}

fn head_of(repo: &Path, name: &str) -> String {
    exec::run(&log(), "git", Some(repo), &["rev-parse", name])
        .expect("rev-parse")
        .stdout_lossy()
        .trim()
        .to_string()
}

/// **git が吐いた stderr に平文の資格情報が残らない**（T-24 の点検。CLAUDE.md §4）。
///
/// `git/ops.rs` は個別に `redact` を通していたが、`GitOutput.stderr` そのものは
/// 生のままだった。画面に出る経路（`GitOutput::failure`）とログの経路が
/// これを読むので、**組み立てるところで 1 度だけ**マスクするように変えた。
///
/// **知らないオプションを渡す**のは、git が受け取った文字列をそのまま
/// stderr へ書き返す数少ない経路だから（`fetch <url>` では git 自身が
/// URL の資格情報を落としてしまい、**マスクを外しても通ってしまう**）。
/// 伏せ字になった形まで見ているので、git が書き返さなくなればこのテストは落ちる。
#[test]
fn the_stderr_that_comes_back_carries_no_plain_credentials() {
    let log = log();
    let secret = "ghp_abcdefghijklmnopqrstuvwxyz012345";
    let option = format!("--bogus=https://tatsu:{secret}@example.invalid/r.git");

    let output = exec::run(&log, "git", None, &[&option]).expect("git が起動すること");

    assert!(!output.ok(), "知らないオプションなので失敗するはず");
    assert!(
        output.stderr.contains("tatsu:***@example.invalid/r.git"),
        "git が書き返した URL が伏せ字になっていない: {}",
        output.stderr
    );
    assert!(
        !output.stderr.contains(secret),
        "stderr に平文のトークンが残っている: {}",
        output.stderr
    );

    // コマンドログ側（画面に出るもの）にも残らない。**引数にも入っている。**
    let recorded = format!("{:?}", log.entries());
    assert!(recorded.contains("tatsu:***@"), "コマンドログで伏せ字になっていない");
    assert!(!recorded.contains(secret), "コマンドログに平文が残っている");
}

/// 上流が動いたあとの fetch で、**増えるものと消えるものが両方起きる**こと。
#[test]
fn fetch_adds_and_prunes_remote_refs() {
    let (_dir, repo) = client_with_origin();

    let before = remote_refs(&repo);
    assert!(before.contains(&"refs/remotes/origin/gone".to_string()), "{before:?}");
    assert!(!before.contains(&"refs/remotes/origin/feature".to_string()), "{before:?}");
    let old_main = head_of(&repo, "refs/remotes/origin/main");

    let mut seen = Vec::new();
    let outcome = ops::fetch(&log(), "git", &repo, &Cancel::new(), &mut |progress| {
        seen.push(progress)
    })
    .expect("fetch を起動できること");

    assert_eq!(outcome.status, FetchStatus::Success, "{outcome:#?}");

    let after = remote_refs(&repo);
    assert!(
        after.contains(&"refs/remotes/origin/feature".to_string()),
        "新しいブランチが増えていない: {after:?}",
    );
    assert!(
        !after.contains(&"refs/remotes/origin/gone".to_string()),
        "--prune で消えるはずの ref が残っている: {after:?}",
    );
    assert_ne!(
        head_of(&repo, "refs/remotes/origin/main"),
        old_main,
        "上流が進んだのに origin/main が動いていない",
    );

    // ref が動いたのだから「更新はありません」にはならない。
    assert!(outcome.message.contains("更新"), "{}", outcome.message);
}

/// **`FETCH_HEAD` の有無が放置判定の入力になる**（docs/DESIGN.md §8.3）。
#[test]
fn fetch_writes_fetch_head() {
    let (_dir, repo) = client_with_origin();

    let probe_before = repo::probe(&log(), "git", &repo);
    assert_eq!(probe_before.remotes, vec!["origin".to_string()]);
    assert_eq!(
        probe_before.last_fetch_at_ms, None,
        "生成時に FETCH_HEAD を消しているので、まだ一度も fetch していない",
    );
    assert!(ops::is_stale(true, probe_before.last_fetch_at_ms, 0, 7));

    ops::fetch(&log(), "git", &repo, &Cancel::new(), &mut |_| {}).expect("fetch");

    let probe_after = repo::probe(&log(), "git", &repo);
    let last = probe_after
        .last_fetch_at_ms
        .expect("fetch したら FETCH_HEAD ができる");
    assert!(!ops::is_stale(true, Some(last), last, 7), "直後は古くない");
}

/// **リモートが無いリポジトリでは放置警告を出さない。**
/// 出すと、ローカルだけのリポジトリで永久に警告が出続ける。
#[test]
fn a_repository_without_remotes_never_goes_stale() {
    let probe = repo::probe(&log(), "git", &fixtures().join("linear"));

    assert!(probe.is_repository);
    assert!(probe.remotes.is_empty(), "{:?}", probe.remotes);
    assert_eq!(probe.last_fetch_at_ms, None);
    assert!(!ops::is_stale(
        !probe.remotes.is_empty(),
        probe.last_fetch_at_ms,
        i64::MAX / 2,
        7,
    ));
}

/// リモートが無くても `fetch --all` は成功する（何もしないだけ）。
#[test]
fn fetching_without_remotes_succeeds_quietly() {
    let (_dir, repo) = working_copy("linear");

    let outcome = ops::fetch(&log(), "git", &repo, &Cancel::new(), &mut |_| {}).expect("fetch");

    assert_eq!(outcome.status, FetchStatus::Success, "{outcome:#?}");
    assert!(outcome.message.contains("更新はありません"), "{}", outcome.message);
}

/// **中止は失敗ではない。** 中止すると git は非ゼロで落ちるので、
/// 成否を先に見ると利用者自身の操作を「失敗しました」と報告してしまう。
#[test]
fn a_cancelled_fetch_is_reported_as_cancelled() {
    let (_dir, repo) = client_with_origin();

    let cancel = Cancel::new();
    cancel.cancel();

    let outcome = ops::fetch(&log(), "git", &repo, &cancel, &mut |_| {}).expect("fetch を起動できること");

    assert_eq!(outcome.status, FetchStatus::Cancelled, "{outcome:#?}");
    assert!(
        outcome.message.contains("残っています"),
        "取り込み済みの分が残ることを伝えること: {}",
        outcome.message,
    );
}

/// **平文のトークンが結果に出ないこと**（CLAUDE.md §4）。
///
/// **伏せているのがどちらなのかは、この試験では分からない。** この git は
/// `unable to access` の URL から資格情報そのものを落として出す。それでも
/// 実物を通した経路で漏れていないことを見ておく価値はあるので残す
/// （伏せる側の担保は `ops.rs` の `body_lines_are_redacted`）。
#[test]
fn credentials_in_a_remote_url_are_masked() {
    let (_dir, repo) = client_with_origin();

    // 届かない相手をわざと足す。**127.0.0.1:1 は即座に接続を拒否される**ので待たない。
    exec::run(
        &log(),
        "git",
        Some(&repo),
        &[
            "remote",
            "add",
            "creds",
            "https://someone:s3cr3t-token-value@127.0.0.1:1/x.git",
        ],
    )
    .expect("remote add");

    let outcome = ops::fetch(&log(), "git", &repo, &Cancel::new(), &mut |_| {})
        .expect("fetch を起動できること");

    let text = format!("{}\n{}", outcome.message, outcome.lines.join("\n"));
    assert!(
        !text.contains("s3cr3t-token-value"),
        "平文のトークンが結果に残っている:\n{text}",
    );
}

/// **上流がタグを付け替えたときに「失敗」で片付けないこと。**
///
/// git は `--force` 無しでは同名タグを上書きしないので、fetch は非ゼロで終わる。
/// だがブランチは取り込めているので、そのまま「失敗しました」と出すと、
/// 直しようがないのに壊れたように見える（利用者の報告で分かった）。
#[test]
fn a_retagged_upstream_is_partial_and_says_what_to_run() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let origin = dir.path().join("fetch-tag-origin.git");
    let client = dir.path().join("fetch-tag-client");
    copy_dir(&fixtures().join("fetch-tag-origin.git"), &origin);
    copy_dir(&fixtures().join("fetch-tag-client"), &client);

    let url = origin.display().to_string();
    let output = exec::run(
        &log(),
        "git",
        Some(&client),
        &["remote", "set-url", "origin", &url],
    )
    .expect("remote set-url");
    assert!(output.ok(), "{}", output.stderr);

    let outcome = ops::fetch(&log(), "git", &client, &Cancel::new(), &mut |_| {})
        .expect("fetch を起動できること");

    assert_eq!(outcome.status, FetchStatus::Partial, "{outcome:#?}");
    assert!(outcome.message.contains("v1"), "どのタグかを言うこと: {}", outcome.message);
    assert!(
        outcome.message.contains("git fetch --tags --force"),
        "自分で直す方法まで言うこと: {}",
        outcome.message,
    );
    assert!(
        outcome
            .lines
            .iter()
            .any(|line| line.contains("would clobber existing tag")),
        "生の行も残すこと: {:#?}",
        outcome.lines,
    );
}
