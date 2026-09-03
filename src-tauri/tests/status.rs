//! 作業ツリーの状態（T-16）を生成済みリポジトリに対して通す結合テスト。
//!
//! 形ごとの期待値は `src/git/status.rs` のユニットテスト側で見る。
//! ここで見るのは「**実物の git 出力でも 3 セクションに分かれる**」ことと、
//! 衝突しているパスが二重に数えられないこと。

mod common;

use givsoner_lib::git::status::{self, WorkingTree};

use common::{fixtures, log};

fn working_tree(repo: &str) -> WorkingTree {
    status::working_tree(&log(), "git", &fixtures().join(repo))
        .unwrap_or_else(|error| panic!("{repo} の作業ツリーを読めません: {error}"))
}

fn paths(changes: &[givsoner_lib::git::diff::FileChange]) -> Vec<&str> {
    let mut list: Vec<&str> = changes.iter().map(|change| change.path.as_str()).collect();
    list.sort();
    list
}

/// クリーンなリポジトリでは何も出ない。**擬似行を出すかどうかの判断はここ**。
#[test]
fn a_clean_repository_is_clean() {
    let tree = working_tree("linear");

    assert!(tree.is_clean(), "何も変えていないのに汚れている: {tree:#?}");
    assert!(tree.staged.is_empty());
    assert!(tree.unstaged.is_empty());
    assert!(tree.untracked.is_empty());
    assert!(tree.unmerged.is_empty());
}

/// ステージ済み / 未ステージ / 未追跡が分かれること。
#[test]
fn splits_staged_unstaged_and_untracked() {
    let tree = working_tree("dirty");

    assert!(!tree.is_clean());
    // リネームは**変更後のパス**で出る（コミットの一覧と同じ）。
    assert_eq!(paths(&tree.staged), vec!["staged.txt", "sub/both.txt", "新しい名前.txt"]);
    assert_eq!(paths(&tree.unstaged), vec!["sub/both.txt", "unstaged.txt"]);
    assert_eq!(tree.untracked, vec!["未追跡.txt"]);
    assert!(tree.unmerged.is_empty());
    assert!(!tree.index_lock_present);
}

/// **1 つのファイルが両方に出ることがある。** `git add` の後にもう一度直した場合。
#[test]
fn a_file_can_be_in_both_sections() {
    let tree = working_tree("dirty");

    let staged = tree
        .staged
        .iter()
        .find(|change| change.path == "sub/both.txt")
        .expect("ステージ済みにあるはず");
    let unstaged = tree
        .unstaged
        .iter()
        .find(|change| change.path == "sub/both.txt")
        .expect("未ステージにもあるはず");

    assert_eq!(staged.additions, Some(1));
    assert_eq!(unstaged.additions, Some(1));
}

/// リネームは変更前のパスも持つ（差分の pathspec に要る — CLAUDE.md §2）。
#[test]
fn a_staged_rename_keeps_the_old_path() {
    let tree = working_tree("dirty");

    let renamed = tree
        .staged
        .iter()
        .find(|change| change.path == "新しい名前.txt")
        .expect("リネームがあるはず");

    assert_eq!(renamed.old_path.as_deref(), Some("古い名前.txt"));
}

/// **衝突しているパスを二重に数えないこと。**
///
/// `git diff --raw` は衝突しているパスを状態 `U` として出し、しかも未ステージ側では
/// 同じパスが 2 度出る。衝突は別のセクションで数えているので、ここから外している。
#[test]
fn a_conflict_is_counted_once() {
    let tree = working_tree("conflict");

    assert_eq!(tree.unmerged, vec!["f.txt"]);
    assert!(
        !tree.staged.iter().any(|change| change.path == "f.txt"),
        "衝突がステージ済みにも出ている: {:#?}",
        tree.staged
    );
    assert!(
        !tree.unstaged.iter().any(|change| change.path == "f.txt"),
        "衝突が未ステージにも出ている: {:#?}",
        tree.unstaged
    );
    assert!(!tree.is_clean());
}

/// 未追跡ファイルは全文で読む（差分にしない — docs/DESIGN.md §7.5）。
#[test]
fn reads_an_untracked_file() {
    let file = status::read_working_file(&fixtures().join("dirty"), "未追跡.txt")
        .expect("未追跡ファイルを読めるはず");

    assert!(!file.binary);
    assert!(!file.too_large);
    assert_eq!(file.text.expect("本文があるはず").text, "未追跡の中身\n");
}

/// **リポジトリの外は読まない。** 一覧から渡す前提でも、外へ出られる経路は作らない。
#[test]
fn refuses_to_escape_the_repository() {
    let escaped = status::read_working_file(&fixtures().join("dirty"), "../linear/a.txt");
    assert!(escaped.is_err(), "リポジトリの外を読めてしまった");
}

/// 無いファイルはエラー。黙って空を返さない。
#[test]
fn a_missing_file_is_an_error() {
    let missing = status::read_working_file(&fixtures().join("dirty"), "無い.txt");
    assert!(missing.is_err());
}
