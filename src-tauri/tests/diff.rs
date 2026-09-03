//! コミット本文と変更ファイル一覧（T-11）を生成済みリポジトリに対して通す結合テスト。
//!
//! 形ごとの期待値は `src/git/diff.rs` のユニットテスト側で見る。
//! ここで見るのは「**実物の git 出力でも同じ形が返る**」ことと、
//! ルートコミット・マージコミットという**別コマンドを使う経路**が動くこと。
//!
//! 差分本体（T-13）もここで通す。**リネームの pathspec と文字コード・改行**は
//! 実物でしか確かめられない。

mod common;

use givsoner_lib::encoding::{LineEnding, TextEncoding};
use givsoner_lib::git::diff::{
    self, ChangeStatus, DiffLineKind, DiffOptions, DiffTarget, FileChange, FileDiff, Revisions,
};
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
    diff::changed_files(
        &log(),
        "git",
        &fixtures().join(repo),
        Revisions::Range {
            from: parent,
            to: sha,
            symmetric: false,
        },
    )
    .unwrap_or_else(|error| panic!("{repo} の変更ファイルを取れません: {error}"))
}

/// 2 点比較（T-15）。`symmetric` なら `A...B`（マージベース起点）。
fn compare(
    repo: &str,
    from: &str,
    to: &str,
    symmetric: bool,
) -> Result<Vec<FileChange>, String> {
    diff::changed_files(
        &log(),
        "git",
        &fixtures().join(repo),
        Revisions::Range {
            from: Some(from),
            to,
            symmetric,
        },
    )
}

/// 同じ比較を git CLI に直接訊く。**テストコードでだけ git を呼んでよい**（CLAUDE.md §8）。
fn git_name_only(repo: &str, range: &[&str]) -> Vec<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(fixtures().join(repo))
        .args(["-c", "core.quotepath=false", "diff", "--name-only"])
        .args(range)
        .output()
        .expect("git を起動できません");

    assert!(
        output.status.success(),
        "git diff --name-only が失敗しました: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let mut paths: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::to_string)
        .collect();
    paths.sort();
    paths
}

fn paths_of(changes: &[FileChange]) -> Vec<String> {
    let mut paths: Vec<String> = changes.iter().map(|change| change.path.clone()).collect();
    paths.sort();
    paths
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

    // リネーム / 追加 / 削除 / サブディレクトリ / バイナリ 3 種 / Shift_JIS / CRLF。
    assert_eq!(changes.len(), 9, "9 ファイル変わっているはず: {changes:#?}");

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

    assert_eq!(changes.len(), 7, "最初のコミットは 7 ファイル: {changes:#?}");
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
        diff::changed_files(
            &log(),
            "git",
            &fixtures().join("linear"),
            Revisions::Range {
                from: None,
                to: missing,
                symmetric: false,
            },
        )
        .is_err()
    );
}

/* ---------- 差分本体（T-13） ---------- */

fn diff_of(
    repo: &str,
    parent: Option<&str>,
    sha: &str,
    path: &str,
    old_path: Option<&str>,
    options: &DiffOptions,
) -> FileDiff {
    diff::file_diff(
        &log(),
        "git",
        &fixtures().join(repo),
        &DiffTarget {
            revisions: Revisions::Range {
                from: parent,
                to: sha,
                symmetric: false,
            },
            path,
            old_path,
        },
        options,
    )
    .unwrap_or_else(|error| panic!("{repo}:{path} の差分を取れません: {error}"))
}

/// 行を `+a` / `-b` / ` c` の形に潰して並びを見る。
fn shape(diff: &FileDiff) -> Vec<String> {
    diff.hunks
        .iter()
        .flat_map(|hunk| {
            hunk.lines.iter().map(|line| {
                let mark = match line.kind {
                    DiffLineKind::Context => ' ',
                    DiffLineKind::Added => '+',
                    DiffLineKind::Removed => '-',
                };
                format!("{mark}{}", line.text)
            })
        })
        .collect()
}

#[test]
fn reads_a_hunk_of_a_modified_file() {
    let snapshot = snapshot_of("changes");
    let head = commit_by_subject(&snapshot, "変更の種類ひととおり");

    let diff = diff_of(
        "changes",
        Some(&head.parents[0]),
        &head.sha,
        "sub/keep.txt",
        None,
        &DiffOptions::default(),
    );

    assert!(!diff.binary);
    assert_eq!(shape(&diff), vec![" x", "+y", "+z"]);
    assert_eq!(diff.hunks[0].new_start, 1);
}

/// **リネームは古いパスも渡さないと検出できない。**
///
/// 新しいパスだけを pathspec に渡すと、git は対になる側が見えないので
/// 「全行が追加された新規ファイル」として出す。ここが崩れると、リネームのたびに
/// 差分が全行追加になって読めなくなる。
#[test]
fn rename_needs_both_paths_in_the_pathspec() {
    let snapshot = snapshot_of("changes");
    let head = commit_by_subject(&snapshot, "変更の種類ひととおり");

    let paired = diff_of(
        "changes",
        Some(&head.parents[0]),
        &head.sha,
        "リネーム後.txt",
        Some("old.txt"),
        &DiffOptions::default(),
    );
    assert_eq!(shape(&paired), vec![" a", " b", " c", "+d"]);

    // 古いパスを渡さなかった場合（＝やってはいけない呼び方）。
    let alone = diff_of(
        "changes",
        Some(&head.parents[0]),
        &head.sha,
        "リネーム後.txt",
        None,
        &DiffOptions::default(),
    );
    assert_eq!(shape(&alone), vec!["+a", "+b", "+c", "+d"]);
}

/// ルートコミットは `git diff` では出せないので `diff-tree -p --root` を使う。
#[test]
fn reads_the_root_commit_diff() {
    let snapshot = snapshot_of("changes");
    let root = commit_by_subject(&snapshot, "最初のコミット");
    assert!(root.parents.is_empty(), "ルートコミットのはず");

    let diff = diff_of(
        "changes",
        None,
        &root.sha,
        "sub/keep.txt",
        None,
        &DiffOptions::default(),
    );

    assert_eq!(shape(&diff), vec!["+x"]);
    assert_eq!(diff.hunks[0].old_lines, 0);
}

/// Shift_JIS のファイルが化けずに出ること（docs/DESIGN.md §9.1）。
#[test]
fn decodes_a_shift_jis_file() {
    let snapshot = snapshot_of("changes");
    let head = commit_by_subject(&snapshot, "変更の種類ひととおり");

    let diff = diff_of(
        "changes",
        Some(&head.parents[0]),
        &head.sha,
        "sjis.txt",
        None,
        &DiffOptions::default(),
    );

    assert_eq!(diff.encoding, TextEncoding::ShiftJis);
    assert!(!diff.lossy);
    assert!(
        diff.hunks[0]
            .lines
            .iter()
            .any(|line| line.text.contains("日本語")),
        "実際の行: {:?}",
        shape(&diff)
    );
}

/// 手動上書きで判別を飛ばせること。**間違った指定なら化けて `lossy` が立つ。**
#[test]
fn forced_encoding_reaches_the_decoder() {
    let snapshot = snapshot_of("changes");
    let head = commit_by_subject(&snapshot, "変更の種類ひととおり");

    let diff = diff_of(
        "changes",
        Some(&head.parents[0]),
        &head.sha,
        "sjis.txt",
        None,
        &DiffOptions {
            encoding: Some(TextEncoding::Utf8),
            ..DiffOptions::default()
        },
    );

    assert_eq!(diff.encoding, TextEncoding::Utf8);
    assert!(diff.lossy, "UTF-8 として読めないので置換文字が出るはず");
}

/// CRLF のファイル。**本文に CR を残さず、改行コードとして数える。**
#[test]
fn detects_crlf_line_endings() {
    let snapshot = snapshot_of("changes");
    let head = commit_by_subject(&snapshot, "変更の種類ひととおり");

    let diff = diff_of(
        "changes",
        Some(&head.parents[0]),
        &head.sha,
        "crlf.txt",
        None,
        &DiffOptions::default(),
    );

    assert_eq!(diff.dominant_line_ending, Some(LineEnding::Crlf));
    assert!(!diff.mixed_line_endings);
    assert_eq!(diff.line_endings.lf, 0);
    assert!(
        shape(&diff).iter().all(|line| !line.contains('\r')),
        "本文に CR が残っている: {:?}",
        shape(&diff)
    );
}

/// LF のファイルは LF と出ること（CRLF の判定が全部に効いていないことの裏取り）。
#[test]
fn detects_lf_line_endings() {
    let snapshot = snapshot_of("changes");
    let head = commit_by_subject(&snapshot, "変更の種類ひととおり");

    let diff = diff_of(
        "changes",
        Some(&head.parents[0]),
        &head.sha,
        "sub/keep.txt",
        None,
        &DiffOptions::default(),
    );

    assert_eq!(diff.dominant_line_ending, Some(LineEnding::Lf));
    assert!(!diff.mixed_line_endings);
}

#[test]
fn binary_files_have_no_hunks() {
    let snapshot = snapshot_of("changes");
    let head = commit_by_subject(&snapshot, "変更の種類ひととおり");

    let diff = diff_of(
        "changes",
        Some(&head.parents[0]),
        &head.sha,
        "blob.bin",
        None,
        &DiffOptions::default(),
    );

    assert!(diff.binary);
    assert!(diff.hunks.is_empty());
    // 行数の代わりにサイズの変化を出す（docs/DESIGN.md §7.2）。
    assert_eq!((diff.old_size, diff.new_size), (Some(6), Some(8)));
}

/// **片側が無いバイナリのサイズは `None`。0 ではない。**
///
/// 0 と書いてしまうと「空のファイルになった」と読めてしまう。
#[test]
fn added_and_deleted_binaries_have_one_side_only() {
    let snapshot = snapshot_of("changes");
    let head = commit_by_subject(&snapshot, "変更の種類ひととおり");
    let parent = Some(head.parents[0].as_str());

    let added = diff_of("changes", parent, &head.sha, "追加.bin", None, &DiffOptions::default());
    assert!(added.binary);
    assert_eq!((added.old_size, added.new_size), (None, Some(7)));

    let deleted = diff_of("changes", parent, &head.sha, "消える.bin", None, &DiffOptions::default());
    assert!(deleted.binary);
    assert_eq!((deleted.old_size, deleted.new_size), (Some(6), None));

    // ルートコミットは親が無いので、変更前は常に `None`。
    let root = commit_by_subject(&snapshot, "最初のコミット");
    let first = diff_of("changes", None, &root.sha, "blob.bin", None, &DiffOptions::default());
    assert_eq!((first.old_size, first.new_size), (None, Some(6)));
}

/// テキストではサイズを取りに行かない（git を 2 回余分に叩かないため）。
#[test]
fn text_diffs_do_not_carry_sizes() {
    let snapshot = snapshot_of("changes");
    let head = commit_by_subject(&snapshot, "変更の種類ひととおり");

    let diff = diff_of(
        "changes",
        Some(&head.parents[0]),
        &head.sha,
        "sub/keep.txt",
        None,
        &DiffOptions::default(),
    );

    assert_eq!((diff.old_size, diff.new_size), (None, None));
}

/// コンテキスト行の増減が効くこと。
#[test]
fn context_lines_change_the_surrounding_lines() {
    let snapshot = snapshot_of("changes");
    let head = commit_by_subject(&snapshot, "変更の種類ひととおり");

    let none = diff_of(
        "changes",
        Some(&head.parents[0]),
        &head.sha,
        "リネーム後.txt",
        Some("old.txt"),
        &DiffOptions {
            context_lines: 0,
            ..DiffOptions::default()
        },
    );
    assert_eq!(shape(&none), vec!["+d"]);

    let wide = diff_of(
        "changes",
        Some(&head.parents[0]),
        &head.sha,
        "リネーム後.txt",
        Some("old.txt"),
        &DiffOptions {
            context_lines: 10,
            ..DiffOptions::default()
        },
    );
    assert_eq!(shape(&wide), vec![" a", " b", " c", "+d"]);
}

/* ---------- 任意 2 コミット間差分（T-15） ---------- */

/// **`A B` と `A...B` は分岐したブランチどうしで結果が変わる。**
///
/// `A B` は 2 点のツリーを直接比べるので、`A` 側にしかない変更が「削除」として出る。
/// `A...B` はマージベースを起点にするので、`B` 側で起きたことだけが出る。
#[test]
fn two_dot_and_three_dot_differ_when_branches_diverged() {
    let snapshot = snapshot_of("branch-merge");
    let feature = &commit_by_subject(&snapshot, "feature の作業").sha;
    let main = &commit_by_subject(&snapshot, "main の作業").sha;

    let two_dot = compare("branch-merge", feature, main, false).expect("2 点間差分");
    let three_dot = compare("branch-merge", feature, main, true).expect("マージベース起点");

    // git CLI と一致すること。
    assert_eq!(paths_of(&two_dot), git_name_only("branch-merge", &[feature, main]));
    assert_eq!(
        paths_of(&three_dot),
        git_name_only("branch-merge", &[&format!("{feature}...{main}")])
    );

    // 意味が違うこと。`A B` では feature 側のファイルが削除として出る。
    assert_eq!(paths_of(&two_dot), vec!["feature.txt", "main.txt"]);
    assert_eq!(paths_of(&three_dot), vec!["main.txt"]);
    assert_eq!(
        find(&two_dot, "feature.txt").status,
        ChangeStatus::Deleted,
        "2 点間差分では feature 側の追加が削除に見える"
    );
}

/// **マージベースが無い 2 点では `A...B` が成立しない。**
///
/// `A B` はツリーを直接比べるだけなので成立する。ここを取り違えると、
/// orphan ブランチと比べたときに黙って空の差分が出る。
#[test]
fn unrelated_histories_have_no_merge_base() {
    let snapshot = snapshot_of("orphan");
    let trunk = &commit_by_subject(&snapshot, "幹の 2 つ目").sha;
    let island = &commit_by_subject(&snapshot, "orphan の 2 つ目").sha;

    let two_dot = compare("orphan", trunk, island, false).expect("2 点間差分は取れる");
    assert_eq!(paths_of(&two_dot), git_name_only("orphan", &[trunk, island]));
    assert!(!two_dot.is_empty(), "無関係でもツリーの差は出る");

    // **git の `no merge base` は言い換える**（何を選んだせいで失敗したか分からないため）。
    let error = compare("orphan", trunk, island, true).expect_err("`A...B` は失敗するはず");
    assert!(error.contains("共通の祖先がありません"), "説明が足りない: {error}");
}

/// 差分本体も 2 点比較で取れること（`A...B` を 1 つの引数として渡せているか）。
#[test]
fn a_file_diff_can_compare_two_commits() {
    let snapshot = snapshot_of("branch-merge");
    let feature = &commit_by_subject(&snapshot, "feature の作業").sha;
    let main = &commit_by_subject(&snapshot, "main の作業").sha;

    let diff = diff::file_diff(
        &log(),
        "git",
        &fixtures().join("branch-merge"),
        &DiffTarget {
            revisions: Revisions::Range {
                from: Some(feature),
                to: main,
                symmetric: true,
            },
            path: "main.txt",
            old_path: None,
        },
        &DiffOptions::default(),
    )
    .expect("2 点間の差分を取れるはず");

    assert!(!diff.hunks.is_empty(), "main.txt が追加されているはず");
    assert!(shape(&diff).iter().all(|line| line.starts_with('+')));
}
