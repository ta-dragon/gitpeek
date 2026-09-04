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

use givsoner_lib::git::exec;
use givsoner_lib::git::ops::{self, CheckoutTarget};

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
    assert!(
        outcome.message.contains("既にあります"),
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
    let tree = givsoner_lib::git::status::working_tree(&log(), "git", &repo).expect("status");

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
