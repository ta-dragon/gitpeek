//! コミット本文と変更ファイル一覧（T-11）を生成済みリポジトリに対して通す結合テスト。
//!
//! 形ごとの期待値は `src/git/diff.rs` のユニットテスト側で見る。
//! ここで見るのは「**実物の git 出力でも同じ形が返る**」ことと、
//! ルートコミット・マージコミットという**別コマンドを使う経路**が動くこと。

mod common;

use givsoner_lib::git::diff::{self, ChangeStatus, FileChange};
use givsoner_lib::git::snapshot;
use givsoner_lib::model::{CommitMeta, RepositorySnapshot};

use common::{fixtures, log};

fn snapshot_of(name: &str) -> RepositorySnapshot {
    snapshot::load(&log(), "git", &fixtures().join(name))
        .unwrap_or_else(|error| panic!("{name} を読めません: {error}"))
}

/// subject でコミットを引く。SHA は生成のたびに変わるので直書きできない。
fn commit_by_subject<'a>(snapshot: &'a RepositorySnapshot, subject: &str) -> &'a CommitMeta {
    snapshot
        .commits
        .iter()
        .find(|commit| commit.subject == subject)
        .unwrap_or_else(|| panic!("subject が {subject} のコミットが無い"))
}

fn changes_of(repo: &str, parent: Option<&str>, sha: &str) -> Vec<FileChange> {
    diff::changed_files(&log(), "git", &fixtures().join(repo), parent, sha)
        .unwrap_or_else(|error| panic!("{repo} の変更ファイルを取れません: {error}"))
}

fn find<'a>(changes: &'a [FileChange], path: &str) -> &'a FileChange {
    changes
        .iter()
        .find(|change| change.path == path)
        .unwrap_or_else(|| {
            panic!(
                "{path} が一覧に無い。あるのは {:?}",
                changes.iter().map(|c| &c.path).collect::<Vec<_>>()
            )
        })
}

#[test]
fn reads_the_full_message_and_committer() {
    let snapshot = snapshot_of("changes");
    let head = commit_by_subject(&snapshot, "変更の種類ひととおり");

    let detail = diff::commit_detail(&log(), "git", &fixtures().join("changes"), &head.sha)
        .expect("本文を取れるはず");

    assert_eq!(detail.sha, head.sha);
    assert_eq!(detail.subject, "変更の種類ひととおり");
    assert_eq!(detail.body, "本文の段落。");
    // 生成スクリプトが author と committer に同じ値を入れている。
    assert_eq!(detail.author_name, "Givsoner Test");
    assert_eq!(detail.committer_name, "Givsoner Test");
    assert_eq!(detail.committer_time, detail.author_time);
    assert_eq!(detail.parents.len(), 1);
}

/// 一覧に載るメタ情報と本文が食い違わないこと。
#[test]
fn the_detail_agrees_with_the_listed_metadata() {
    let snapshot = snapshot_of("linear");
    for commit in &snapshot.commits {
        let detail = diff::commit_detail(&log(), "git", &fixtures().join("linear"), &commit.sha)
            .expect("本文を取れるはず");
        assert_eq!(detail.short_sha, commit.short_sha);
        assert_eq!(detail.parents, commit.parents);
        assert_eq!(detail.subject, commit.subject);
        assert_eq!(detail.author_time, commit.author_time);
    }
}

/// 追加 / 変更 / 削除 / リネーム / バイナリが 1 コミットで全部出ること。
#[test]
fn reads_every_kind_of_change() {
    let snapshot = snapshot_of("changes");
    let head = commit_by_subject(&snapshot, "変更の種類ひととおり");
    let changes = changes_of("changes", Some(&head.parents[0]), &head.sha);

    assert_eq!(changes.len(), 5, "5 ファイル変わっているはず: {changes:#?}");

    let renamed = find(&changes, "リネーム後.txt");
    assert_eq!(renamed.status, ChangeStatus::Renamed);
    assert_eq!(renamed.old_path.as_deref(), Some("old.txt"));
    assert_eq!((renamed.additions, renamed.deletions), (Some(1), Some(0)));

    let added = find(&changes, "追加.txt");
    assert_eq!(added.status, ChangeStatus::Added);
    assert_eq!(added.old_mode, "000000");

    let deleted = find(&changes, "消える.txt");
    assert_eq!(deleted.status, ChangeStatus::Deleted);
    assert_eq!(deleted.new_mode, "000000");

    // サブディレクトリまで潜ること。
    let nested = find(&changes, "sub/keep.txt");
    assert_eq!(nested.status, ChangeStatus::Modified);
    assert_eq!((nested.additions, nested.deletions), (Some(2), Some(0)));

    let binary = find(&changes, "blob.bin");
    assert!(binary.is_binary(), "バイナリの行数は取れない");
    assert_eq!(binary.status, ChangeStatus::Modified);
}

/// 日本語ファイル名が 8 進エスケープされないこと（`core.quotepath=false`）。
#[test]
fn keeps_japanese_paths_unescaped() {
    let snapshot = snapshot_of("japanese");
    let commit = commit_by_subject(&snapshot, "入れ子も置く");
    let changes = changes_of("japanese", Some(&commit.parents[0]), &commit.sha);

    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].path, "ディレクトリ/入れ子のファイル.txt");
}

/// **ルートコミットは `git diff` では出せない。** `diff-tree --root` の経路を通ること。
#[test]
fn a_root_commit_lists_every_file_as_added() {
    let snapshot = snapshot_of("changes");
    let root = snapshot
        .commits
        .iter()
        .find(|commit| commit.parents.is_empty())
        .expect("ルートコミットがある");

    let changes = changes_of("changes", None, &root.sha);

    assert_eq!(changes.len(), 4, "最初のコミットは 4 ファイル: {changes:#?}");
    assert!(
        changes.iter().all(|change| change.status == ChangeStatus::Added),
        "ルートコミットは全部 Added のはず"
    );
    // サブディレクトリも潜れていること（`-r` が抜けると `sub` 1 件になる）。
    assert_eq!(find(&changes, "sub/keep.txt").additions, Some(1));
    assert!(find(&changes, "blob.bin").is_binary());
}

/// マージコミットは親を切り替えると一覧が変わる（docs/DESIGN.md §7.4）。
#[test]
fn a_merge_commit_differs_by_parent() {
    let snapshot = snapshot_of("branch-merge");
    let merge = snapshot
        .commits
        .iter()
        .find(|commit| commit.parents.len() > 1)
        .expect("マージコミットがある");

    let first = changes_of("branch-merge", Some(&merge.parents[0]), &merge.sha);
    let second = changes_of("branch-merge", Some(&merge.parents[1]), &merge.sha);

    // main 側から見ると feature の変更が、feature 側から見ると main の変更が入る。
    assert_eq!(first.len(), 1, "{first:#?}");
    assert_eq!(first[0].path, "feature.txt");
    assert_eq!(second.len(), 1, "{second:#?}");
    assert_eq!(second[0].path, "main.txt");
}

/// 空 subject のコミットでも本文の取得が失敗しないこと。
#[test]
fn an_empty_subject_is_not_an_error() {
    let snapshot = snapshot_of("empty-subject");
    let commit = snapshot
        .commits
        .iter()
        .find(|commit| commit.subject.is_empty())
        .expect("空 subject のコミットがある");

    let detail = diff::commit_detail(&log(), "git", &fixtures().join("empty-subject"), &commit.sha)
        .expect("本文を取れるはず");

    assert_eq!(detail.subject, "");
    assert_eq!(detail.body, "");
}

/// 複数行メッセージで subject と本文が正しく割れること。
#[test]
fn splits_the_subject_from_the_body() {
    let snapshot = snapshot_of("messages");
    let commit = commit_by_subject(&snapshot, "1 行目の要約 2 行目も同じ段落");

    let detail = diff::commit_detail(&log(), "git", &fixtures().join("messages"), &commit.sha)
        .expect("本文を取れるはず");

    // `%s` は最初の段落を 1 行に畳むが、`%b` は畳まない。
    assert_eq!(detail.subject, "1 行目の要約 2 行目も同じ段落");
    assert_eq!(detail.body, "本文の段落。");
}

/// 存在しない SHA は握り潰さずエラーにする。
#[test]
fn an_unknown_sha_is_an_error() {
    let missing = "0000000000000000000000000000000000000000";
    assert!(diff::commit_detail(&log(), "git", &fixtures().join("linear"), missing).is_err());
    assert!(
        diff::changed_files(&log(), "git", &fixtures().join("linear"), None, missing).is_err()
    );
}
