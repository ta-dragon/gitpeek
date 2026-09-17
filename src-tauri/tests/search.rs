//! コミット検索（T-35）の結合テスト。
//!
//! 実際の `git` を生成済みリポジトリ（`search`）に対して走らせる（docs/DESIGN.md §14.3）。
//! 引数の組み立てそのものは `src/git/search.rs` 側の単体テストが見ている。
//!
//! **ここで確かめたいのは「git に聞いているからこそ当たる」ほうの性質**である。
//! 一覧が持っているのは `%s`（要約 1 行）だけなので、**本文にしか無い語で当たること**が
//! 手元で探していないことの証拠になる。

mod common;

use gitpeek_lib::commandlog::CommandLog;
use gitpeek_lib::git::exec::Cancel;
use gitpeek_lib::git::search::{self, CommitQuery};
use gitpeek_lib::git::snapshot;

use common::{fixtures, log};

/// 探して、当たったコミットの要約を返す。**SHA では読めないので要約に直す。**
fn subjects_of(repo: &str, query: &CommitQuery) -> Vec<String> {
    let path = fixtures().join(repo);
    let snapshot = snapshot::load(&log(), "git", &path)
        .unwrap_or_else(|error| panic!("{repo} を読めません: {error}"));
    let found = search::search(&log(), "git", &path, query, snapshot.head.sha.is_some(), &Cancel::new())
        .unwrap_or_else(|error| panic!("探せません: {error}"));

    found
        .shas
        .iter()
        .map(|sha| {
            snapshot
                .commits
                .iter()
                .find(|commit| &commit.sha == sha)
                .map(|commit| commit.subject.clone())
                .unwrap_or_else(|| format!("<一覧に無い {sha}>"))
        })
        .collect()
}

fn bare(word: &str) -> CommitQuery {
    CommitQuery {
        any: Some(word.to_string()),
        ..CommitQuery::default()
    }
}

fn message(word: &str) -> CommitQuery {
    CommitQuery {
        message: Some(word.to_string()),
        ..CommitQuery::default()
    }
}

fn author(word: &str) -> CommitQuery {
    CommitQuery {
        author: Some(word.to_string()),
        ..CommitQuery::default()
    }
}

#[test]
fn a_word_that_only_the_subject_has_is_found() {
    assert_eq!(subjects_of("search", &message("subjectonly")), ["subjectonly の要約"]);
}

#[test]
fn a_word_that_only_the_body_has_is_found() {
    // **要約には無い語。** 手元の `%s` で探していたら当たらない（CLAUDE.md §2）。
    assert_eq!(subjects_of("search", &message("bodyonly")), ["ふつうの要約"]);
}

#[test]
fn the_case_of_the_letters_does_not_matter() {
    assert_eq!(subjects_of("search", &message("SubjectOnly")).len(), 1);
    assert_eq!(subjects_of("search", &message("BODYONLY")).len(), 1);
}

#[test]
fn an_author_is_found_by_name_and_by_mail() {
    assert_eq!(subjects_of("search", &author("Hanako")), ["別の作者のコミット"]);
    assert_eq!(
        subjects_of("search", &author("hanako@example.invalid")),
        ["別の作者のコミット"]
    );
    // 全員が持っているメールのドメインでは全件当たる（作者で絞れていることの裏返し）。
    assert!(subjects_of("search", &author("example.invalid")).len() > 1);
}

#[test]
fn a_bare_word_matches_either_the_message_or_the_author() {
    // メッセージにしか無い語でも、作者にしか無い語でも当たる。
    assert_eq!(subjects_of("search", &bare("bodyonly")), ["ふつうの要約"]);
    assert_eq!(subjects_of("search", &bare("Hanako")), ["別の作者のコミット"]);
}

#[test]
fn named_words_narrow_each_other() {
    // メッセージと作者を両方書いたら AND。**`--all-match` を付けないと OR になる。**
    let both = CommitQuery {
        message: Some("要約".to_string()),
        author: Some("Hanako".to_string()),
        ..CommitQuery::default()
    };
    assert!(subjects_of("search", &both).is_empty());

    // 作者だけを外すと、メッセージ側だけで当たるものが残る。
    assert!(subjects_of("search", &message("要約")).len() >= 2);
}

#[test]
fn a_bare_word_narrows_a_named_one() {
    // （メッセージ or 作者）AND 作者。2 回の実行の和を取っても AND が崩れない。
    let query = CommitQuery {
        any: Some("別の作者".to_string()),
        author: Some("Hanako".to_string()),
        ..CommitQuery::default()
    };
    assert_eq!(subjects_of("search", &query), ["別の作者のコミット"]);

    let missing = CommitQuery {
        any: Some("bodyonly".to_string()),
        author: Some("Hanako".to_string()),
        ..CommitQuery::default()
    };
    assert!(subjects_of("search", &missing).is_empty());
}

#[test]
fn a_bare_word_narrowing_an_author_ignores_letter_case() {
    // 作者を 2 つ求める回は、片方を git に渡さず Rust で絞る（git は OR してしまう）。
    // **そちらでも大文字小文字を区別しない**こと（git に任せた側と揃える）。
    let query = CommitQuery {
        any: Some("HANAKO".to_string()),
        author: Some("example.invalid".to_string()),
        ..CommitQuery::default()
    };
    assert_eq!(subjects_of("search", &query), ["別の作者のコミット"]);
}

#[test]
fn a_commit_found_by_both_runs_is_returned_once() {
    // 「e」はメッセージにも、全員の作者（メール）にも入っている。2 回の実行の両方で当たる。
    let path = fixtures().join("search");
    let found =
        search::search(&log(), "git", &path, &bare("e"), true, &Cancel::new()).expect("探せません");
    let unique: std::collections::HashSet<&String> = found.shas.iter().collect();
    assert!(!found.shas.is_empty());
    assert_eq!(unique.len(), found.shas.len(), "同じコミットが二重に返った");
}

#[test]
fn a_folder_that_is_not_a_repository_is_an_error() {
    // git が失敗したら、黙って 0 件にしない（「当たりませんでした」と取り違える）。
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let error = search::search(&log(), "git", dir.path(), &message("x"), false, &Cancel::new())
        .expect_err("リポジトリでないフォルダは失敗にする");
    assert!(!error.is_empty());
}

#[test]
fn a_value_that_starts_with_a_dash_is_not_a_flag() {
    // `--grep` と値を別の引数に割ると、git がフラグとして食って落ちる。
    assert_eq!(
        subjects_of("search", &message("--pretty")),
        ["オプション --pretty の説明を直す"]
    );
}

#[test]
fn japanese_is_found() {
    // core.quotepath=false と UTF-8 の往復。8 進エスケープになっていたら当たらない。
    assert_eq!(subjects_of("search", &message("別の作者")), ["別の作者のコミット"]);
}

#[test]
fn a_commit_only_a_tag_points_at_is_not_found() {
    // タグを起点 ref にしない（CLAUDE.md §2 / docs/DESIGN.md §4.2）。
    // `--all` で探していたらここで当たってしまう。
    assert!(subjects_of("search", &message("tagonly")).is_empty());
}

#[test]
fn nothing_matching_is_not_an_error() {
    assert!(subjects_of("search", &message("該当なしのことば")).is_empty());
}

#[test]
fn an_empty_query_does_not_run_git() {
    let recorded = CommandLog::default();
    let path = fixtures().join("search");
    let error = search::search(&recorded, "git", &path, &CommitQuery::default(), true, &Cancel::new())
        .expect_err("空のクエリは実行してはいけない");
    assert!(!error.is_empty());
    assert!(recorded.entries().is_empty(), "git を走らせている");
}

#[test]
fn a_repository_without_commits_does_not_pass_head() {
    // unborn HEAD に `HEAD` を渡すと git log 全体が失敗する。
    let path = fixtures().join("empty");
    let snapshot = snapshot::load(&log(), "git", &path).expect("空のリポジトリを読めない");
    assert!(snapshot.head.sha.is_none());

    let found = search::search(&log(), "git", &path, &message("なんでも"), false, &Cancel::new())
        .expect("コミット 0 件でも失敗してはいけない");
    assert!(found.shas.is_empty());
}

#[test]
fn a_bare_word_runs_git_twice_and_a_named_one_once() {
    // git が `--grep` と `--author` を AND するので、OR は 2 回に割るしかない。
    // **回数が増えていないこと**も併せて見る（CLAUDE.md §2）。
    let twice = CommandLog::default();
    let path = fixtures().join("search");
    search::search(&twice, "git", &path, &bare("要約"), true, &Cancel::new()).expect("探せません");
    assert_eq!(count_log_runs(&twice), 2);

    let once = CommandLog::default();
    search::search(&once, "git", &path, &message("要約"), true, &Cancel::new()).expect("探せません");
    assert_eq!(count_log_runs(&once), 1);
}

fn count_log_runs(log: &CommandLog) -> usize {
    log.entries()
        .iter()
        .filter(|entry| entry.args.first().is_some_and(|arg| arg == "log"))
        .count()
}

fn code(word: &str) -> CommitQuery {
    CommitQuery {
        code: Some(word.to_string()),
        ..CommitQuery::default()
    }
}

#[test]
fn code_finds_the_commit_that_added_it_and_the_one_that_removed_it() {
    // `-S` は「その語の出現回数が変わったコミット」。足したほうも消したほうも当たる。
    // **メッセージには書いていない語**なので、コード側で当たっている。
    let mut found = subjects_of("search", &code("NEEDLE_CODE"));
    let mut expected = vec!["設定を足す".to_string(), "設定を消す".to_string()];
    found.sort();
    expected.sort();
    assert_eq!(found, expected);
}

#[test]
fn the_case_of_the_letters_does_not_matter_for_code_either() {
    // **`-i` は `-S` にも効く**（git 2.43 で実測。docs/DESIGN.md §6.6）。
    // 効かない git だと、ここが黙って 0 件になる。
    assert_eq!(subjects_of("search", &code("needle_code")).len(), 2);
}

#[test]
fn code_and_message_are_asked_in_one_run() {
    // 同じ 1 回にまとめると、grep で落ちたコミットの差分を git が取らない
    // （onyx で 17.1 秒 → 5.9 秒）。**分けて和や積を取る形にしない。**
    let recorded = CommandLog::default();
    let path = fixtures().join("search");
    let query = CommitQuery {
        message: Some("足す".to_string()),
        code: Some("NEEDLE_CODE".to_string()),
        ..CommitQuery::default()
    };
    let found =
        search::search(&recorded, "git", &path, &query, true, &Cancel::new()).expect("探せません");
    assert_eq!(count_log_runs(&recorded), 1);
    assert_eq!(found.shas.len(), 1, "AND になっていない");
}

#[test]
fn a_cancelled_search_is_not_a_failure_and_stops_there() {
    // **中止は失敗ではない。** 落とされた git は非ゼロで終わるので、成否を先に見ると
    // 利用者自身の操作を「探せませんでした」と報告してしまう。
    let recorded = CommandLog::default();
    let path = fixtures().join("search");
    let cancel = Cancel::new();
    cancel.cancel();

    // 素のことばは 2 回に割れる。中止したら 2 回目へ進まない。
    let outcome = search::search(&recorded, "git", &path, &bare("要約"), true, &cancel)
        .expect("中止してもエラーにしない");
    assert!(outcome.cancelled);
    assert_eq!(count_log_runs(&recorded), 1, "中止したのに次の実行へ進んでいる");
}

#[test]
fn a_search_that_was_not_cancelled_says_so() {
    let found = search::search(
        &log(),
        "git",
        &fixtures().join("search"),
        &message("要約"),
        true,
        &Cancel::new(),
    )
    .expect("探せません");
    assert!(!found.cancelled);
}

/// **本当に長い `-S` を途中で落とせること**（T-36）。
///
/// 生成するリポジトリは小さく、`-S` が一瞬で終わるので、見張りスレッドが子を落とす経路を
/// 通せない。手元に onyx（20,285 コミット、`-S` で 17 秒）があるときだけ流す。
/// `cargo test --test search -- --ignored` で手動実行する。
#[test]
#[ignore = "手元の onyx（C:/Gitwork/onyx）が要る。手動で流す"]
fn a_long_code_search_can_be_stopped_midway() {
    let path = std::path::PathBuf::from("C:/Gitwork/onyx");
    assert!(path.is_dir(), "onyx がありません");

    let cancel = Cancel::new();
    let stopper = cancel.clone();
    let started = std::time::Instant::now();
    let stopper_thread = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1_500));
        stopper.cancel();
    });

    let outcome = search::search(&log(), "git", &path, &code("def get_session"), true, &cancel)
        .expect("中止してもエラーにしない");
    stopper_thread.join().expect("止め役のスレッド");

    let elapsed = started.elapsed();
    assert!(outcome.cancelled);
    // 見張りは 100ms 刻み。落とせていなければ 17 秒近くかかる。
    assert!(
        elapsed < std::time::Duration::from_secs(4),
        "中止が効いていない: {elapsed:?}",
    );
}
