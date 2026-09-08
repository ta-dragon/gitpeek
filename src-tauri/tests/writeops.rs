//! checkout と FF マージ（T-18）を生成済みリポジトリに対して通す結合テスト。
//!
//! 判定そのもの（bare / 汚れている / `index.lock` / 未追跡だけなら止めない）は
//! `src/git/ops.rs` のユニットテスト側で見る。ここで見るのは
//! 「**実物の git を相手にしたときに、意図した ref だけが動く**」こと。
//!
//! とくに **`origin/main` を checkout してもローカルブランチが増えないこと**は
//! ここでしか確かめられない。git の DWIM は引数の形だけで挙動が変わるので、
//! 引数の組み立てを固定するユニットテストとは別に、実際に走らせて数える。
//!
//! **どちらもリポジトリを書き換える**ので、テストごとに複製してから触る。

mod common;

use std::path::{Path, PathBuf};

use gitpeek_lib::git::exec::{self, Cancel};
use gitpeek_lib::git::ops::{self, CheckoutTarget, FetchStatus};

use common::{fixtures, log};

/// 生成済みリポジトリを丸ごと複製して、その複製を返す。
fn working_copy(name: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let target = dir.path().join(name);
    copy_dir(&fixtures().join(name), &target);
    (dir, target)
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

/// `symbolic-ref --short HEAD`。detached なら `None`。
fn head_branch(repo: &Path) -> Option<String> {
    exec::run(
        &log(),
        "git",
        Some(repo),
        &["symbolic-ref", "-q", "--short", "HEAD"],
    )
    .ok()
    .filter(exec::GitOutput::ok)
    .map(|output| output.stdout_lossy().trim().to_string())
    .filter(|value| !value.is_empty())
}

fn head_sha(repo: &Path) -> String {
    exec::run(&log(), "git", Some(repo), &["rev-parse", "HEAD"])
        .expect("rev-parse")
        .stdout_lossy()
        .trim()
        .to_string()
}

fn sha_of(repo: &Path, rev: &str) -> String {
    exec::run(&log(), "git", Some(repo), &["rev-parse", rev])
        .expect("rev-parse")
        .stdout_lossy()
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------
// checkout
// ---------------------------------------------------------------------------

#[test]
fn checking_out_a_local_branch_moves_head() {
    let (_dir, repo) = working_copy("branch-merge");
    let before = head_branch(&repo).expect("最初はブランチ上");
    let other = local_branches(&repo)
        .into_iter()
        .find(|name| *name != before)
        .expect("別のブランチがある");

    let outcome = ops::checkout(
        &log(),
        "git",
        &repo,
        &CheckoutTarget::Branch {
            name: other.clone(),
        },
    )
    .expect("checkout");

    assert!(outcome.ok, "切り替えられない: {}", outcome.message);
    assert_eq!(head_branch(&repo).as_deref(), Some(other.as_str()));
}

/// **これが T-18 の要。** リモート追跡ブランチを detached で開いたときに
/// ローカルブランチが増えると、git の DWIM を踏んでいる（CLAUDE.md §1 違反）。
#[test]
fn detaching_onto_a_remote_branch_creates_no_local_branch() {
    let (_dir, repo) = working_copy("ff-client");
    let before = local_branches(&repo);
    assert_eq!(before, ["main"], "前提: ローカルは main だけ");

    let outcome = ops::checkout(
        &log(),
        "git",
        &repo,
        &CheckoutTarget::Detach {
            rev: "refs/remotes/origin/feature".to_string(),
        },
    )
    .expect("checkout");

    assert!(outcome.ok, "切り替えられない: {}", outcome.message);
    assert_eq!(local_branches(&repo), before, "ブランチが勝手に増えた");
    assert_eq!(head_branch(&repo), None, "detached になっていない");
    assert_eq!(head_sha(&repo), sha_of(&repo, "refs/remotes/origin/feature"));
}

/// タグも detached。**軽量タグでも注釈付きタグでも同じ**（peel は git に任せる）。
#[test]
fn checking_out_a_tag_detaches() {
    let (_dir, repo) = working_copy("tags");
    let outcome = ops::checkout(
        &log(),
        "git",
        &repo,
        &CheckoutTarget::Detach {
            rev: "refs/tags/v1.0".to_string(),
        },
    )
    .expect("checkout");

    assert!(outcome.ok, "切り替えられない: {}", outcome.message);
    assert_eq!(head_branch(&repo), None);
}

/// 利用者が選んだときだけローカル追跡ブランチを作る（CLAUDE.md §1）。
#[test]
fn tracking_a_remote_branch_creates_exactly_one_local_branch() {
    let (_dir, repo) = working_copy("ff-client");

    let outcome = ops::checkout(
        &log(),
        "git",
        &repo,
        &CheckoutTarget::Track {
            remote_ref: "refs/remotes/origin/feature".to_string(),
            branch: "feature".to_string(),
        },
    )
    .expect("checkout");

    assert!(outcome.ok, "作れない: {}", outcome.message);
    assert_eq!(local_branches(&repo), ["feature", "main"]);
    assert_eq!(head_branch(&repo).as_deref(), Some("feature"));

    // 追跡先が設定されていること（`--track` を落としても切り替えは成功するので、
    // ここを見ないと「追跡していないブランチ」が静かに残る）。
    let upstream = exec::run(
        &log(),
        "git",
        Some(&repo),
        &["rev-parse", "--abbrev-ref", "feature@{upstream}"],
    )
    .expect("rev-parse");
    assert!(upstream.ok(), "上流が設定されていない: {}", upstream.stderr);
    assert_eq!(upstream.stdout_lossy().trim(), "origin/feature");
}

/// **同じ名前のローカルブランチがあると `-b` は失敗する。** 画面には
/// 「作らずに切り替えてください」と出す（フロントはそもそもこの選択肢を出さない）。
#[test]
fn tracking_a_name_that_already_exists_fails_with_advice() {
    let (_dir, repo) = working_copy("ff-client");

    let outcome = ops::checkout(
        &log(),
        "git",
        &repo,
        &CheckoutTarget::Track {
            remote_ref: "refs/remotes/origin/main".to_string(),
            branch: "main".to_string(),
        },
    )
    .expect("checkout");

    assert!(!outcome.ok);
    // **次にどうすればよいかが書いてあること。** 言い回しではなく、
    // 打つ手を指している語で見る（文言を直すたびに落ちるテストにしない）。
    assert!(
        outcome.message.contains("切り替え"),
        "何をすればいいか分からない: {}",
        outcome.message
    );
    assert_eq!(local_branches(&repo), ["main"], "壊してはいけない");
}

/// 汚れた作業ツリーは**判定で止める**。ここでは判定が実際に立つことだけを見る
/// （止め方そのものはユニットテスト側）。
#[test]
fn a_dirty_repository_is_reported_as_dirty() {
    let (_dir, repo) = working_copy("dirty");
    let tree = gitpeek_lib::git::status::working_tree(&log(), "git", &repo).expect("status");

    let guard = ops::preflight(false, false, false, Some(&tree));
    assert!(!guard.allowed(), "汚れているのに通ってしまう");
    assert!(guard.changed > 0);
}

// ---------------------------------------------------------------------------
// FF マージ
// ---------------------------------------------------------------------------

/// 上流だけが進んでいる形。**新しいコミットは作らない**（親が 1 つのまま）。
#[test]
fn a_behind_branch_fast_forwards() {
    let (_dir, repo) = working_copy("ff-client");
    let target = sha_of(&repo, "refs/remotes/origin/main");
    assert_ne!(head_sha(&repo), target, "前提: 遅れている");

    let outcome = ops::merge_ff(&log(), "git", &repo, "refs/remotes/origin/main").expect("merge");

    assert!(outcome.ok, "取り込めない: {}", outcome.message);
    assert_eq!(head_sha(&repo), target, "上流の先端に並んでいない");
    assert_eq!(
        head_branch(&repo).as_deref(),
        Some("main"),
        "ブランチから外れてはいけない"
    );
}

/// **分岐していたら実行しない**（CLAUDE.md §1 — 非 fast-forward マージは提供しない）。
/// `diverged` は手元が 2 つ進み、上流が 3 つ進んでいる。
#[test]
fn a_diverged_branch_is_refused_without_touching_head() {
    let (_dir, repo) = working_copy("diverged");
    let before = head_sha(&repo);

    let outcome = ops::merge_ff(&log(), "git", &repo, "refs/remotes/origin/main").expect("merge");

    assert!(!outcome.ok, "分岐しているのに取り込んでしまった");
    assert!(
        outcome.message.contains("fast-forward"),
        "理由が伝わらない: {}",
        outcome.message
    );
    assert_eq!(head_sha(&repo), before, "HEAD が動いてはいけない");
}

/// 取り込むものが無いときは成功扱い（git も exit 0）。**壊さないこと**だけ見る。
#[test]
fn merging_an_ancestor_changes_nothing() {
    let (_dir, repo) = working_copy("linear");
    let before = head_sha(&repo);

    let outcome = ops::merge_ff(&log(), "git", &repo, "HEAD").expect("merge");

    assert!(outcome.ok, "{}", outcome.message);
    assert_eq!(head_sha(&repo), before);
}

/// 実行結果の生 stderr も**マスキングを通っている**こと（CLAUDE.md §4）。
#[test]
fn failure_details_are_redacted() {
    let (_dir, repo) = working_copy("linear");
    let outcome = ops::merge_ff(
        &log(),
        "git",
        &repo,
        "https://user:s3cret@example.com/x.git",
    )
    .expect("merge");

    assert!(!outcome.ok);
    let joined = format!("{} {}", outcome.message, outcome.details.join(" "));
    assert!(!joined.contains("s3cret"), "平文が出ている: {joined}");
}

// ---------------------------------------------------------------------------
// 取ってきて取り込む（T-31。docs/DESIGN.md §8.6）
// ---------------------------------------------------------------------------

/// 上流と手元を**両方**複製し、手元の origin を複製側へ向け直す。
///
/// 上流を共有したままにしてはいけない（`tests/fetch.rs` と同じ理由 —
/// 掴まれたファイルが残ると、次のテストバイナリが fixtures を作り直せない）。
fn pair(origin_name: &str, client_name: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let origin = dir.path().join(origin_name);
    let client = dir.path().join(client_name);
    copy_dir(&fixtures().join(origin_name), &origin);
    copy_dir(&fixtures().join(client_name), &client);

    let url = origin.display().to_string();
    let output = exec::run(
        &log(),
        "git",
        Some(&client),
        &["remote", "set-url", "origin", &url],
    )
    .expect("remote set-url");
    assert!(output.ok(), "上流を複製側へ向け直せない: {}", output.stderr);

    (dir, origin, client)
}

/// `lib.rs` の `guard_for` と同じ材料の集め方。**判定そのものは `preflight` の 1 か所。**
fn guard_of(repo: &Path) -> ops::WriteGuard {
    let probe = gitpeek_lib::git::repo::probe(&log(), "git", repo);
    let unborn = matches!(
        probe.head,
        Some(gitpeek_lib::git::repo::HeadState::Unborn { .. })
    );
    let tree = if probe.is_bare {
        None
    } else {
        gitpeek_lib::git::status::working_tree(&log(), "git", repo).ok()
    };
    ops::preflight(probe.is_bare, unborn, probe.index_lock_present, tree.as_ref())
}

/// 取ってきて取り込む。返り値の 2 つ目は**「取り込みへ移った」合図が来た回数**。
///
/// **判定は `lib.rs` と同じ `merge_check_of_ref` を通す。** テストが自前で数えると、
/// 実際に使われる判定は一度も試されない（申し送り 10「緑になった理由まで見る」）。
fn fetch_and_merge(
    repo: &Path,
    rev: &str,
    guard: &ops::WriteGuard,
) -> (ops::FetchMergeOutcome, usize) {
    let mut merging = 0usize;
    let mut progress = |_: gitpeek_lib::git::fetchprogress::FetchProgress| {};
    let mut on_merging = || merging += 1;
    let mut check = || {
        let snapshot = gitpeek_lib::git::snapshot::load(&log(), "git", repo)?;
        Ok(gitpeek_lib::merge_check_of_ref(&snapshot, rev))
    };

    let outcome = ops::fetch_and_merge(
        &log(),
        "git",
        repo,
        rev,
        guard,
        &Cancel::new(),
        ops::FetchMergeHooks {
            on_progress: &mut progress,
            on_merging: &mut on_merging,
            check: &mut check,
        },
    )
    .expect("起動できること");

    // **借用を先に手放してから数える。** `merging` は `on_merging` が握っている。
    let (_, _, _) = (progress, on_merging, check);
    (outcome, merging)
}

/// **これが T-31 の要。** 上流が進んでいるとき、取ってきてそのまま取り込む。
///
/// `fetch-client` は clone した**あとで**上流が動いた形なので、
/// 取ってこないと `origin/main` は動かない（＝取り込むものが無い）。
#[test]
fn an_upstream_that_moved_is_fetched_and_then_merged() {
    let (_dir, _origin, repo) = pair("fetch-origin.git", "fetch-client");
    let before = head_sha(&repo);
    assert_eq!(
        sha_of(&repo, "refs/remotes/origin/main"),
        before,
        "前提: 取ってくる前は遅れていない",
    );

    let (outcome, merging) = fetch_and_merge(&repo, "refs/remotes/origin/main", &guard_of(&repo));

    let fetched = outcome.fetch.expect("fetch まで進むこと");
    assert_eq!(fetched.status, FetchStatus::Success, "{fetched:#?}");

    let check = outcome.check.expect("取り込む前に判定を通すこと");
    assert_eq!(
        (check.ahead, check.behind, check.known),
        (0, 1, true),
        "{check:?}"
    );

    let merged = outcome.merge.expect("取り込みまで進むこと");
    assert!(merged.ok, "取り込めない: {}", merged.message);
    assert_eq!(merging, 1, "取り込みへ移る合図を 1 度だけ出すこと");

    assert_ne!(head_sha(&repo), before, "HEAD が動いていない");
    assert_eq!(
        head_sha(&repo),
        sha_of(&repo, "refs/remotes/origin/main"),
        "上流の先端に並んでいない",
    );
    assert_eq!(
        head_branch(&repo).as_deref(),
        Some("main"),
        "ブランチから外れてはいけない",
    );
    // **勝手にローカルブランチを作らない**（CLAUDE.md §1）。
    // 取ってくると `origin/feature` が増えるので、DWIM を踏むならここに出る。
    assert_eq!(local_branches(&repo), ["main"], "ローカルブランチが増えた");
}

/// **分岐していたら取り込まない。** 取ってくるところまでは進み、
/// 判定の結果（ahead / behind）をそのまま返す（画面はこれを読んで理由を出す）。
#[test]
fn a_diverged_branch_is_fetched_but_not_merged() {
    let (_dir, _origin, repo) = pair("upstream.git", "diverged");
    let before = head_sha(&repo);
    let branches = local_branches(&repo);

    let (outcome, merging) = fetch_and_merge(&repo, "refs/remotes/origin/main", &guard_of(&repo));

    assert_eq!(
        outcome.fetch.expect("fetch は走ること").status,
        FetchStatus::Success,
    );
    let check = outcome.check.expect("判定を通すこと");
    assert_eq!(
        (check.ahead, check.behind, check.known),
        (2, 3, true),
        "{check:?}"
    );
    assert!(!check.can_fast_forward(), "分岐しているのに通してしまう");

    assert!(
        outcome.merge.is_none(),
        "取り込んではいけない: {:#?}",
        outcome.merge
    );
    assert_eq!(merging, 0, "取り込みへ移ってはいけない");
    assert_eq!(head_sha(&repo), before, "HEAD が動いてはいけない");
    assert_eq!(local_branches(&repo), branches, "ローカルブランチが増えた");
}

/// **判定が通らなければ fetch もしない**（docs/DESIGN.md §8.6）。
///
/// 「走らなかった」ことを `refused` だけで見ると、**fetch は走っていたのに
/// 緑になる**。`origin/main` が動いていないことで、git 自体が起きていないことを見る。
#[test]
fn a_dirty_repository_is_refused_before_the_fetch_runs() {
    let (_dir, _origin, repo) = pair("fetch-origin.git", "fetch-client");
    std::fs::write(repo.join("a.txt"), "手を入れた\n").expect("汚す");

    let before = head_sha(&repo);
    let remote_before = sha_of(&repo, "refs/remotes/origin/main");

    let guard = guard_of(&repo);
    assert!(!guard.allowed(), "前提: 汚れていること");

    let (outcome, merging) = fetch_and_merge(&repo, "refs/remotes/origin/main", &guard);

    assert!(outcome.fetch.is_none(), "fetch まで走ってしまった");
    assert!(outcome.check.is_none());
    assert!(outcome.merge.is_none());
    assert_eq!(merging, 0);
    let refused = outcome.refused.expect("止めた理由を返すこと");
    assert!(refused.blockers.contains(&ops::Blocker::Dirty), "{refused:?}");

    assert_eq!(head_sha(&repo), before, "HEAD が動いてはいけない");
    assert_eq!(
        sha_of(&repo, "refs/remotes/origin/main"),
        remote_before,
        "リモート追跡 ref が動いている＝fetch が走っている",
    );
}

/// **上流がタグを付け替えていても取り込みへ進む**（`FetchStatus::Partial`。DESIGN.md §8.6）。
///
/// ブランチは取り込めており、タグは早送りの可否に関係しない。ここで止めると、
/// タグを手で直すまでこの操作が使えなくなる。
#[test]
fn a_retagged_upstream_is_partial_but_still_merges() {
    let (_dir, origin, repo) = pair("fetch-tag-origin.git", "fetch-tag-client");

    // 生成時の上流は**タグだけ**を付け替えている。ブランチも進めて、
    // 「タグは弾かれるが main は進む」形にする。**テストからは git を呼んでよい。**
    let output = exec::run(
        &log(),
        "git",
        Some(&origin),
        &["update-ref", "refs/heads/main", "refs/tags/v1"],
    )
    .expect("update-ref");
    assert!(output.ok(), "{}", output.stderr);

    let before = head_sha(&repo);
    let (outcome, merging) = fetch_and_merge(&repo, "refs/remotes/origin/main", &guard_of(&repo));

    let fetched = outcome.fetch.expect("fetch まで進むこと");
    assert_eq!(fetched.status, FetchStatus::Partial, "{fetched:#?}");

    let merged = outcome.merge.expect("一部でも取り込みへ進むこと");
    assert!(merged.ok, "取り込めない: {}", merged.message);
    assert_eq!(merging, 1);
    assert_ne!(head_sha(&repo), before, "HEAD が動いていない");
    assert_eq!(head_branch(&repo).as_deref(), Some("main"));
}

/// 取り込むものが無いときは**走らせない。** git は exit 0 で何もしないが、
/// 「取り込みました」と報告すると、実際に何か起きたのか読めなくなる。
#[test]
fn nothing_to_merge_does_not_run_the_merge() {
    let (_dir, _origin, repo) = pair("ff-origin.git", "ff-client");
    // `ff-client` は生成時に fetch 済みで、上流はもう動かない。先に並べてしまう。
    let merged = ops::merge_ff(&log(), "git", &repo, "refs/remotes/origin/main").expect("merge");
    assert!(merged.ok, "{}", merged.message);
    let before = head_sha(&repo);

    let (outcome, merging) = fetch_and_merge(&repo, "refs/remotes/origin/main", &guard_of(&repo));

    let check = outcome.check.expect("判定を通すこと");
    assert_eq!((check.ahead, check.behind), (0, 0), "{check:?}");
    assert!(outcome.merge.is_none(), "走らせてはいけない");
    assert_eq!(merging, 0);
    assert_eq!(head_sha(&repo), before);
}

/// **detached では取り込む先が無い。** 判定が `detached` を落とすと、
/// 画面は「取り込むものがありません」という見当違いの理由を出す。
#[test]
fn a_detached_head_is_reported_as_detached() {
    let (_dir, _origin, repo) = pair("fetch-origin.git", "fetch-client");
    let outcome = ops::checkout(
        &log(),
        "git",
        &repo,
        &CheckoutTarget::Detach {
            rev: "HEAD".to_string(),
        },
    )
    .expect("checkout");
    assert!(outcome.ok, "{}", outcome.message);

    let before = head_sha(&repo);
    let (outcome, merging) = fetch_and_merge(&repo, "refs/remotes/origin/main", &guard_of(&repo));

    let check = outcome.check.expect("判定を通すこと");
    assert!(check.detached, "detached を落としている: {check:?}");
    assert!(outcome.merge.is_none());
    assert_eq!(merging, 0);
    assert_eq!(head_sha(&repo), before);
}
