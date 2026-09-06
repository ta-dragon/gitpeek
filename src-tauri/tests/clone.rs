//! clone（T-19）を実物の git に対して通す結合テスト。
//!
//! 引数の固定とフォルダ名の検証は `src/git/ops.rs` のユニットテスト側で見る。
//! ここで見るのは「**実物の git を相手にしても clone でき、失敗したら後始末される**」こと。
//!
//! ネットワークには出ない。生成済みの bare（`bare.git`）をローカルパスで clone する。
//! git はローカルパスの clone でも `--progress` の進捗を出すので、進捗の経路も通る。

mod common;

use std::path::Path;

use gitpeek_lib::commandlog::CommandLog;
use gitpeek_lib::git::exec::{self, Cancel};
use gitpeek_lib::git::ops::{self, CloneRequest, CloneStatus};

use common::{fixtures, log};

fn request(url: &str, parent: &Path, name: &str) -> CloneRequest {
    CloneRequest {
        url: url.to_string(),
        parent_directory: parent.display().to_string(),
        folder_name: name.to_string(),
        // **既定は取り込まない**（CLAUDE.md §1）。取り込む試験だけ上書きする。
        recurse_submodules: false,
    }
}

/// 生成済みの bare の場所。**URL としてそのまま git へ渡せる。**
fn source_url() -> String {
    fixtures().join("bare.git").display().to_string()
}

/// ローカルブランチの短い名前。**テストコードからは git を呼んでよい**（CLAUDE.md §8）。
fn local_branches(repo: &Path) -> Vec<String> {
    let output = exec::run(
        &log(),
        "git",
        Some(repo),
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )
    .expect("for-each-ref");
    let mut names: Vec<String> = output
        .stdout_lossy()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    names.sort();
    names
}

/// **生成した bare からローカル clone できること。**
///
/// 開けるリポジトリになっていることまで見る（`.git` があるだけでは足りない）。
#[test]
fn cloning_a_generated_bare_produces_a_usable_repository() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let request = request(&source_url(), dir.path(), "cloned-here");

    let mut seen = Vec::new();
    let outcome = ops::clone(&log(), "git", &request, &Cancel::new(), &mut |progress| {
        seen.push(progress)
    })
    .expect("clone を起動できること");

    assert_eq!(outcome.status, CloneStatus::Success, "{outcome:#?}");
    let path = outcome.path.as_deref().expect("clone 先を返すこと");
    let path = Path::new(path);
    assert_eq!(path, dir.path().join("cloned-here"));
    assert!(path.join(".git").is_dir(), "作業ツリー付きで clone すること");

    // 履歴が丸ごと来ていること。**浅くしていない**（CLAUDE.md §1）。
    let probe = gitpeek_lib::git::repo::probe(&log(), "git", path);
    assert!(probe.is_repository, "{probe:#?}");
    assert!(!probe.is_shallow, "shallow にしてはいけない: {probe:#?}");
    assert!(!probe.is_bare, "{probe:#?}");
    assert_eq!(probe.remotes, vec!["origin".to_string()]);
    assert!(!local_branches(path).is_empty(), "ブランチが 1 本も無い");

    assert!(outcome.leftover.is_none(), "{outcome:#?}");
}

/// **既にあるフォルダを指定したら、git を 1 度も起動せずに止まること。**
///
/// git も拒むが、その英語 stderr より先にこちらの言葉で言う。
/// 「起動していない」ことはコマンドログが空であることで見る。
#[test]
fn an_existing_folder_stops_before_git_runs() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let occupied = dir.path().join("occupied");
    std::fs::create_dir(&occupied).expect("既存フォルダを作る");
    std::fs::write(occupied.join("大事なファイル.txt"), b"keep me").expect("中身を置く");

    let log = CommandLog::default();
    let outcome = ops::clone(
        &log,
        "git",
        &request(&source_url(), dir.path(), "occupied"),
        &Cancel::new(),
        &mut |_| {},
    )
    .expect("結果を返すこと");

    assert_eq!(outcome.status, CloneStatus::Failed, "{outcome:#?}");
    assert!(outcome.message.contains("既にあります"), "{}", outcome.message);
    assert!(
        log.entries().is_empty(),
        "git を起動してはいけない: {:#?}",
        log.entries(),
    );

    // **消していないこと。** ここを間違えると利用者のフォルダを消す事故になる。
    assert!(occupied.join("大事なファイル.txt").is_file(), "既存の中身を消した");
}

/// **失敗しても、自分が作らなかったフォルダは消さない。**
///
/// 実行前に「無かった」と確かめられたときにしか消さない、という構造を固定する。
/// ここでは親フォルダ（既にある）が残ることで見る。
#[test]
fn a_failed_clone_leaves_folders_it_did_not_create() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let parent = dir.path().join("ワークスペース");
    std::fs::create_dir(&parent).expect("親フォルダを作る");
    std::fs::write(parent.join("隣のファイル.txt"), b"keep me").expect("中身を置く");

    // 存在しないローカルパスを相手にする。**ネットワークへは出ない。**
    let missing = dir.path().join("no-such-repo.git").display().to_string();
    let outcome = ops::clone(
        &log(),
        "git",
        &request(&missing, &parent, "取り込み先"),
        &Cancel::new(),
        &mut |_| {},
    )
    .expect("clone を起動できること");

    assert_eq!(outcome.status, CloneStatus::Failed, "{outcome:#?}");
    assert!(parent.is_dir(), "親フォルダを消してはいけない");
    assert!(parent.join("隣のファイル.txt").is_file(), "隣のファイルを消した");
    assert!(
        !parent.join("取り込み先").exists(),
        "自分が作った残骸は消すこと: {outcome:#?}",
    );
    assert!(outcome.leftover.is_none(), "{outcome:#?}");
}

/// **中止は失敗ではない。** 中止すると git は非ゼロで落ちるので、
/// 成否を先に見ると利用者自身の操作を「失敗しました」と報告してしまう。
///
/// 併せて**残骸が残らないこと**も見る（clone は fetch と扱いが違う）。
#[test]
fn a_cancelled_clone_is_reported_as_cancelled_and_cleans_up() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");

    let cancel = Cancel::new();
    cancel.cancel();

    let outcome = ops::clone(
        &log(),
        "git",
        &request(&source_url(), dir.path(), "中止する"),
        &cancel,
        &mut |_| {},
    )
    .expect("clone を起動できること");

    assert_eq!(outcome.status, CloneStatus::Cancelled, "{outcome:#?}");
    assert!(
        !dir.path().join("中止する").exists(),
        "中止したら残骸を消すこと: {outcome:#?}",
    );
    assert_eq!(outcome.leftover, None, "{outcome:#?}");
}

/// **資格情報付きの URL が結果とコマンドログでマスクされること**（CLAUDE.md §4）。
///
/// URL 欄は利用者が貼り付ける場所なので、`https://<user>:<token>@…` が入りうる。
/// 引数はそのまま `git clone` に渡るため、**コマンドログが平文の入口になる。**
#[test]
fn credentials_in_the_url_are_masked_everywhere() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let log = CommandLog::default();

    // 届かない相手をわざと指す。**127.0.0.1:1 は即座に接続を拒否される**ので待たない。
    let url = "https://someone:s3cr3t-token-value@127.0.0.1:1/x.git";
    let outcome = ops::clone(
        &log,
        "git",
        &request(url, dir.path(), "creds"),
        &Cancel::new(),
        &mut |_| {},
    )
    .expect("clone を起動できること");

    assert_eq!(outcome.status, CloneStatus::Failed, "{outcome:#?}");

    let shown = format!("{}\n{}", outcome.message, outcome.lines.join("\n"));
    assert!(
        !shown.contains("s3cr3t-token-value"),
        "平文のトークンが結果に残っている:\n{shown}",
    );

    let logged = log
        .entries()
        .iter()
        .map(|entry| format!("{} {}", entry.args.join(" "), entry.stderr))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !logged.contains("s3cr3t-token-value"),
        "平文のトークンがコマンドログに残っている:\n{logged}",
    );
    assert!(
        logged.contains("127.0.0.1"),
        "何を触ったのかは残すこと:\n{logged}",
    );
}

/// **チェックが実際に git まで届いていること**（2026-09-05 に追加した選択肢）。
///
/// 引数の組み立て（`clone_args`）はユニットテストで固定してあるが、それだけでは
/// 「チェックボックスは動くのにフラグが 1 度も渡っていない」形の壊れ方を拾えない。
/// **実際に起動したプロセスの記録**で見る。
///
/// **サブモジュールが実際に取り込まれることは、ここでは確かめられない。**
/// git 2.38 以降はサブモジュールの `file` トランスポートを既定で拒むので
/// （`fatal: transport 'file' not allowed`。この環境の git 2.43 で実測）、
/// ローカルパスの上流では成功しない。`protocol.file.allow` を緩めるのは
/// **全 git 呼び出しに効いてしまう**ので行わない（CLAUDE.md §2）。
/// 実物のサブモジュール付きリポジトリでの確認は目視に回す。
#[test]
fn the_submodule_flag_reaches_git() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let log = CommandLog::default();

    let mut request = request(&source_url(), dir.path(), "with-submodules");
    request.recurse_submodules = true;

    // サブモジュールを持たないリポジトリなので、フラグを付けても素通りして成功する。
    let outcome =
        ops::clone(&log, "git", &request, &Cancel::new(), &mut |_| {}).expect("clone を起動できること");
    assert_eq!(outcome.status, CloneStatus::Success, "{outcome:#?}");

    let args = log
        .entries()
        .into_iter()
        .find(|entry| entry.args.first().map(String::as_str) == Some("clone"))
        .expect("clone を起動した記録があること")
        .args;
    assert!(
        args.contains(&"--recurse-submodules".to_string()),
        "チェックしたのにフラグが渡っていない: {args:?}",
    );
}

/// **既定では付けない。** 黙って取り込んではいけない（CLAUDE.md §1）。
#[test]
fn the_submodule_flag_is_absent_by_default() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let log = CommandLog::default();

    let outcome = ops::clone(
        &log,
        "git",
        &request(&source_url(), dir.path(), "plain"),
        &Cancel::new(),
        &mut |_| {},
    )
    .expect("clone を起動できること");
    assert_eq!(outcome.status, CloneStatus::Success, "{outcome:#?}");

    let args = log
        .entries()
        .into_iter()
        .find(|entry| entry.args.first().map(String::as_str) == Some("clone"))
        .expect("clone を起動した記録があること")
        .args;
    assert!(
        !args.contains(&"--recurse-submodules".to_string()),
        "頼まれていないのに付けている: {args:?}",
    );
}
