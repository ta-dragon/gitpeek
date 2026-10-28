//! stash の一覧（T-42）を生成済みリポジトリ（`stashes`）に対して通す結合テスト。
//!
//! 書式の分解そのものは `src/git/stash.rs` の単体テストが見ている。ここで見るのは
//! **実物の git が親を 2 つ・3 つで返すこと**と、**stash がグラフに混ざらないこと**。

mod common;

use gitpeek_lib::git::diff::{self, Revisions};
use gitpeek_lib::git::snapshot;
use gitpeek_lib::git::stash::{self, StashEntry};

use common::{fixtures, log};

fn entries() -> Vec<StashEntry> {
    stash::list(&log(), "git", &fixtures().join("stashes"))
        .unwrap_or_else(|error| panic!("stash の一覧を読めません: {error}"))
}

fn message_of(entries: &[StashEntry], label: &str) -> String {
    entries
        .iter()
        .find(|entry| entry.label == label)
        .map(|entry| entry.message.clone())
        .unwrap_or_else(|| panic!("{label} がありません: {entries:#?}"))
}

/// 新しい順に 4 つ。**`-m` を付けたものは `On <ブランチ>:`、付けないものは `WIP on <ブランチ>:`**。
#[test]
fn lists_stashes_newest_first() {
    let entries = entries();

    let labels: Vec<_> = entries.iter().map(|entry| entry.label.as_str()).collect();
    assert_eq!(labels, ["stash@{0}", "stash@{1}", "stash@{2}", "stash@{3}"]);
    assert_eq!(message_of(&entries, "stash@{0}"), "On main: 未追跡あり");
    assert!(
        message_of(&entries, "stash@{1}").starts_with("WIP on main: "),
        "{entries:#?}"
    );
    assert_eq!(message_of(&entries, "stash@{2}"), "On gone: 消したブランチの上");
    assert_eq!(message_of(&entries, "stash@{3}"), "On main: 作業: 日本語のメッセージ");
}

/// `-u` で退避したものだけが第 3 親（未追跡のファイル）を持つ。
#[test]
fn only_the_untracked_stash_has_a_third_parent() {
    let entries = entries();

    let with_untracked: Vec<_> = entries
        .iter()
        .filter(|entry| entry.untracked.is_some())
        .map(|entry| entry.label.as_str())
        .collect();
    assert_eq!(with_untracked, ["stash@{0}"]);
}

/// 未追跡ぶんは第 3 親をルートとして見れば一覧になる（`git stash show` の既定では出ない）。
#[test]
fn the_untracked_files_can_be_listed_from_the_third_parent() {
    let entries = entries();
    let untracked = entries[0].untracked.as_deref().expect("第 3 親がありません");

    let files = diff::changed_files(
        &log(),
        "git",
        &fixtures().join("stashes"),
        Revisions::Range {
            from: None,
            to: untracked,
            symmetric: false,
        },
    )
    .unwrap_or_else(|error| panic!("未追跡ぶんを読めません: {error}"));

    let paths: Vec<_> = files.iter().map(|change| change.path.as_str()).collect();
    assert_eq!(paths, ["未追跡.txt"]);
}

/// 追跡しているぶんは「元のコミット → stash」。**未追跡のファイルはここに出ない。**
#[test]
fn the_tracked_changes_are_base_to_stash() {
    let entries = entries();
    let top = &entries[0];

    let files = diff::changed_files(
        &log(),
        "git",
        &fixtures().join("stashes"),
        Revisions::Range {
            from: Some(&top.base),
            to: &top.sha,
            symmetric: false,
        },
    )
    .unwrap_or_else(|error| panic!("追跡ぶんを読めません: {error}"));

    let paths: Vec<_> = files.iter().map(|change| change.path.as_str()).collect();
    assert_eq!(paths, ["a.txt"]);
}

/// **stash はグラフの起点にならない**（CLAUDE.md §2）。stash そのものも、消したブランチの上の
/// 元のコミットも、グラフのコミットには入らない。
#[test]
fn stashes_do_not_enter_the_graph() {
    let entries = entries();
    let snapshot = snapshot::load(&log(), "git", &fixtures().join("stashes"))
        .unwrap_or_else(|error| panic!("stashes を読めません: {error}"));
    let in_graph = |sha: &str| snapshot.commits.iter().any(|commit| commit.sha == sha);

    for entry in &entries {
        assert!(!in_graph(&entry.sha), "{} がグラフに入っている", entry.label);
    }
    let gone = entries
        .iter()
        .find(|entry| entry.message == "On gone: 消したブランチの上")
        .expect("消したブランチの上の stash がありません");
    assert!(!in_graph(&gone.base), "消したブランチのコミットがグラフに入っている");
    // ほかの stash の元のコミットはグラフの中にある。
    assert!(in_graph(&entries[0].base));
}

/// stash が 1 つも無ければ空で、失敗にしない。
#[test]
fn no_stash_is_an_empty_list() {
    let entries = stash::list(&log(), "git", &fixtures().join("linear"))
        .unwrap_or_else(|error| panic!("linear の stash を読めません: {error}"));

    assert!(entries.is_empty(), "{entries:#?}");
}
