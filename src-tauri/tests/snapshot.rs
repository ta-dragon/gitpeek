//! コミットメタ情報と ref 一覧の一括取得（T-04）の結合テスト。
//!
//! 実際の `git` を生成済みリポジトリに対して走らせる（docs/DESIGN.md §14.3）。
//! 固定文字列に対するパーサ単体テストは `src/git/log.rs` と `src/git/refs.rs` 側。

mod common;

use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use gitpeek_lib::commandlog::CommandLog;
use gitpeek_lib::git::progress::{LoadPhase, LoadProgress, ProgressSink, Reporting};
use gitpeek_lib::git::snapshot::{self, SnapshotCache};
use gitpeek_lib::model::{CommitMeta, RefKind, RepositorySnapshot};

use common::{fixtures, log};

fn snapshot_of(name: &str) -> RepositorySnapshot {
    snapshot::load(&log(), "git", &fixtures().join(name))
        .unwrap_or_else(|error| panic!("{name} を読めません: {error}"))
}

fn find<'a>(snapshot: &'a RepositorySnapshot, subject: &str) -> &'a CommitMeta {
    snapshot
        .commits
        .iter()
        .find(|commit| commit.subject == subject)
        .unwrap_or_else(|| {
            let subjects: Vec<&str> = snapshot
                .commits
                .iter()
                .map(|commit| commit.subject.as_str())
                .collect();
            panic!("subject {subject:?} が無い: {subjects:?}")
        })
}

/// 記録の中に `git log` の実行があるか。キャッシュが効いたかの判定に使う。
fn ran_git_log(log: &CommandLog) -> bool {
    log.entries()
        .iter()
        .any(|entry| entry.args.first().is_some_and(|arg| arg == "log"))
}

fn git(args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .output()
        .expect("git を実行できません");
    assert!(
        output.status.success(),
        "git {args:?} が失敗しました:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn loads_a_linear_history_newest_first() {
    let snapshot = snapshot_of("linear");
    assert_eq!(snapshot.commits.len(), 3);

    // topo-order は新しい方が先に来る。
    let subjects: Vec<&str> = snapshot
        .commits
        .iter()
        .map(|commit| commit.subject.as_str())
        .collect();
    assert_eq!(subjects, ["3 番目", "2 番目", "最初のコミット"]);

    // 親子が繋がっていること。最後の 1 件はルートなので親を持たない。
    for pair in snapshot.commits.windows(2) {
        assert_eq!(pair[0].parents, [pair[1].sha.clone()]);
    }
    assert!(snapshot.commits[2].parents.is_empty());

    let head = &snapshot.commits[0];
    assert_eq!(head.sha.len(), 40, "{}", head.sha);
    assert!(!head.short_sha.is_empty() && head.sha.starts_with(&head.short_sha));
    assert_eq!(head.author_name, "GitPeek Test");
    assert_eq!(head.author_email, "test@example.invalid");
    assert!(head.author_time > 0 && head.commit_time > 0);

    assert_eq!(snapshot.head.branch.as_deref(), Some("main"));
    assert_eq!(snapshot.head.sha.as_deref(), Some(head.sha.as_str()));
    assert!(!snapshot.head.detached && !snapshot.head.unborn);
    assert_eq!(snapshot.default_branch.as_deref(), Some("refs/heads/main"));
    assert_eq!(snapshot.ref_fingerprint.len(), 64, "SHA-256 の 16 進表記");
}

#[test]
fn reads_a_merge_commit_with_two_parents() {
    let snapshot = snapshot_of("branch-merge");
    let merge = find(&snapshot, "Merge branch 'feature'");
    assert_eq!(merge.parents.len(), 2);

    // 第一親は main 側。マージ前の main のコミットである。
    let first_parent = find(&snapshot, "main の作業");
    assert_eq!(merge.parents[0], first_parent.sha);
    let second_parent = find(&snapshot, "feature の作業");
    assert_eq!(merge.parents[1], second_parent.sha);
}

#[test]
fn reads_an_octopus_merge_with_three_parents() {
    let snapshot = snapshot_of("octopus");
    let merge = snapshot
        .commits
        .iter()
        .find(|commit| commit.parents.len() > 2)
        .expect("親が 3 つのコミット");
    assert_eq!(merge.parents.len(), 3);
    assert_eq!(merge.parents[0], find(&snapshot, "main の作業").sha);
}

#[test]
fn includes_every_root_commit() {
    let snapshot = snapshot_of("two-roots");
    let roots: Vec<&CommitMeta> = snapshot
        .commits
        .iter()
        .filter(|commit| commit.parents.is_empty())
        .collect();
    assert_eq!(roots.len(), 2, "無関係な履歴の合流でルートは 2 つ");
}

#[test]
fn keeps_japanese_subjects_unescaped() {
    let snapshot = snapshot_of("japanese");
    // core.quotepath=false が効いていれば 8 進エスケープにならない（CLAUDE.md §2）。
    find(&snapshot, "入れ子も置く");
    find(&snapshot, "日本語のファイル");
}

#[test]
fn keeps_an_empty_subject() {
    let snapshot = snapshot_of("empty-subject");
    assert_eq!(snapshot.commits.len(), 2);
    // 空の subject でもレコードは落ちない。
    assert!(snapshot.commits.iter().any(|commit| commit.subject.is_empty()));
}

#[test]
fn collapses_a_multi_line_message_into_one_subject() {
    let snapshot = snapshot_of("messages");
    assert_eq!(snapshot.commits.len(), 2);

    let subject = &snapshot.commits[0].subject;
    // `%s` は最初の段落を 1 行に畳む。本文は含まない。
    assert_eq!(subject, "1 行目の要約 2 行目も同じ段落");
    assert!(!subject.contains('\n'));
    assert!(!subject.contains("本文"));
}

#[test]
fn handles_a_repository_without_commits() {
    let snapshot = snapshot_of("empty");
    // コミット 0 件へ `HEAD` を渡すと git log 全体が失敗する。失敗させずに空で返す。
    assert!(snapshot.is_empty());
    assert!(snapshot.refs.is_empty());
    assert!(snapshot.head.unborn);
    assert_eq!(snapshot.head.branch.as_deref(), Some("main"));
    assert_eq!(snapshot.head.sha, None);
    assert_eq!(snapshot.default_branch, None);
}

#[test]
fn reports_a_detached_head() {
    let snapshot = snapshot_of("detached");
    assert!(snapshot.head.detached);
    assert_eq!(snapshot.head.branch, None);

    let sha = snapshot.head.sha.as_deref().expect("detached でも SHA はある");
    assert!(snapshot.commits.iter().any(|commit| commit.sha == sha));
    // ブランチが main しかなくても幹は決まる。
    assert_eq!(snapshot.default_branch.as_deref(), Some("refs/heads/main"));
}

#[test]
fn loads_a_bare_repository() {
    let snapshot = snapshot_of("bare.git");
    assert_eq!(snapshot.commits.len(), 3);
    assert_eq!(snapshot.default_branch.as_deref(), Some("refs/heads/main"));
}

#[test]
fn peels_annotated_tags_and_marks_the_unreachable_one() {
    let snapshot = snapshot_of("tags");
    let tag = |short: &str| {
        snapshot
            .refs
            .iter()
            .find(|entry| entry.short_name == short)
            .unwrap_or_else(|| panic!("{short} が無い"))
    };

    let head = &snapshot.commits[0];
    // 注釈付きタグは tag オブジェクトではなくコミットを指すこと。
    let annotated = tag("v2.0");
    assert_eq!(annotated.kind, RefKind::Tag);
    assert_eq!(annotated.target, head.sha);
    assert!(!annotated.out_of_graph);

    // 軽量タグ。
    assert_eq!(tag("v1.0").target, find(&snapshot, "1 つ目").sha);

    // タグは起点 ref にしないので、ブランチの消えたタグはグラフ外になる（§4.2）。
    let orphan = tag("v0.9-orphan");
    assert!(orphan.out_of_graph);
    assert!(!snapshot
        .commits
        .iter()
        .any(|commit| commit.sha == orphan.target));
}

/// 合流しない orphan ブランチの ref だけに印が付くこと（T-27）。
#[test]
fn marks_refs_on_a_disconnected_history() {
    let snapshot = snapshot_of("orphan");
    let entry = |short: &str| {
        snapshot
            .refs
            .iter()
            .find(|entry| entry.short_name == short)
            .unwrap_or_else(|| panic!("{short} が無い"))
    };

    assert!(entry("assets").orphan, "orphan ブランチに印が付いていない");
    assert!(!entry("main").orphan, "幹に印が付いている");
}

/// 合流した無関係履歴は orphan ではない（繋がっているので線も途切れない）。
#[test]
fn a_merged_unrelated_history_is_not_orphan() {
    let snapshot = snapshot_of("two-roots");
    assert!(snapshot.refs.iter().all(|entry| !entry.orphan));
}

#[test]
fn reads_remote_branches_and_upstream() {
    let snapshot = snapshot_of("cloned");

    let local = snapshot
        .refs
        .iter()
        .find(|entry| entry.name == "refs/heads/main")
        .expect("ローカルの main");
    assert_eq!(local.kind, RefKind::LocalBranch);
    assert_eq!(local.upstream.as_deref(), Some("refs/remotes/origin/main"));

    let remote = snapshot
        .refs
        .iter()
        .find(|entry| entry.name == "refs/remotes/origin/main")
        .expect("リモート追跡ブランチ");
    assert_eq!(remote.kind, RefKind::RemoteBranch);
    assert_eq!(remote.short_name, "origin/main");

    // symbolic ref は一覧に出さない。出すと origin/main が二重に見える。
    assert!(!snapshot
        .refs
        .iter()
        .any(|entry| entry.name.ends_with("/HEAD")));
    // origin/HEAD があればそれが幹（CLAUDE.md §3-1）。
    assert_eq!(
        snapshot.default_branch.as_deref(),
        Some("refs/remotes/origin/main")
    );
}

/// `--all` は `refs/tags/`・`refs/stash`・`refs/notes/` まで起点にしてしまう（§4.2）。
#[test]
fn never_passes_all_to_git_log() {
    let sink = log();
    snapshot::load(&sink, "git", &fixtures().join("tags")).unwrap();

    let entries = sink.entries();
    let log_args = entries
        .iter()
        .find(|entry| entry.args.first().is_some_and(|arg| arg == "log"))
        .map(|entry| entry.args.clone())
        .expect("git log が走ること");

    assert!(!log_args.iter().any(|arg| arg == "--all"), "{log_args:?}");
    for expected in ["--branches", "--remotes", "HEAD", "--topo-order", "-z"] {
        assert!(log_args.iter().any(|arg| arg == expected), "{log_args:?}");
    }
}

/// 途中経過を溜めておくだけの受け口。
#[derive(Default)]
struct RecordingProgress(Mutex<Vec<LoadProgress>>);

impl ProgressSink for RecordingProgress {
    fn report(&self, progress: LoadProgress) {
        self.0.lock().expect("progress poisoned").push(progress);
    }
}

impl RecordingProgress {
    fn phases(&self) -> Vec<LoadPhase> {
        self.0
            .lock()
            .expect("progress poisoned")
            .iter()
            .map(|progress| progress.phase)
            .collect()
    }

    fn last(&self) -> LoadProgress {
        self.0
            .lock()
            .expect("progress poisoned")
            .last()
            .cloned()
            .expect("報告が 1 件はあること")
    }
}

#[test]
fn reports_progress_for_each_phase() {
    let recorder = RecordingProgress::default();
    let cache = SnapshotCache::new();
    let snapshot = snapshot::load_cached(
        &log(),
        "git",
        &fixtures().join("linear"),
        &cache,
        "linear",
        false,
        &Reporting::new(&recorder, Some(3)),
    )
    .unwrap();

    // ref 一覧 → コミット取得 → グラフ整理、の順。Commits は速すぎると
    // 報告間隔（150ms）に届かず出ないので、有無は問わない。
    let phases = recorder.phases();
    assert_eq!(phases.first(), Some(&LoadPhase::Refs), "{phases:?}");
    assert_eq!(phases.last(), Some(&LoadPhase::Graph), "{phases:?}");

    // 最後の報告は実際の件数と一致し、分母はそのまま返ってくる。
    let last = recorder.last();
    assert_eq!(last.commits, snapshot.commits.len() as u64);
    assert_eq!(last.estimated_total, Some(3));

    // キャッシュに当たった回は ref を見た時点で返るので Refs だけ。
    let cached = RecordingProgress::default();
    snapshot::load_cached(
        &log(),
        "git",
        &fixtures().join("linear"),
        &cache,
        "linear",
        false,
        &Reporting::new(&cached, Some(3)),
    )
    .unwrap();
    assert_eq!(cached.phases(), vec![LoadPhase::Refs]);
}

#[test]
fn serves_the_cache_until_a_ref_moves() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("clone");
    // 他のテストと共有しない自分専用のリポジトリで ref を動かす。
    git(&[
        "clone",
        "--quiet",
        &fixtures().join("bare.git").display().to_string(),
        &repo.display().to_string(),
    ]);

    let cache = SnapshotCache::new();
    let first = load(&repo, &cache, false);
    assert_eq!(first.1.commits.len(), 3);
    assert!(ran_git_log(&first.0), "1 回目は読みに行く");

    // ref が動いていなければ git log は走らない。
    let second = load(&repo, &cache, false);
    assert!(!ran_git_log(&second.0), "2 回目はキャッシュ");
    assert_eq!(second.1.ref_fingerprint, first.1.ref_fingerprint);
    assert_eq!(second.1.loaded_at, first.1.loaded_at, "同じ読み込み結果");

    // force を立てれば指紋が同じでも読み直す。
    let forced = load(&repo, &cache, true);
    assert!(ran_git_log(&forced.0));

    // タグを 1 つ打てば ref 集合が変わるので、次は読み直す。
    git(&["-C", &repo.display().to_string(), "tag", "v9.9"]);
    let after = load(&repo, &cache, false);
    assert!(ran_git_log(&after.0), "ref が動いたら読み直す");
    assert_ne!(after.1.ref_fingerprint, first.1.ref_fingerprint);
    assert!(after.1.refs.iter().any(|entry| entry.short_name == "v9.9"));
}

/// 記録先を毎回作り直し、「今回 git log が走ったか」を見られるようにする。
fn load(repo: &Path, cache: &SnapshotCache, force: bool) -> (CommandLog, Arc<RepositorySnapshot>) {
    let sink = log();
    let snapshot = snapshot::load_cached(
        &sink,
        "git",
        repo,
        cache,
        "fixture",
        force,
        &Reporting::silent(),
    )
    .expect("スナップショットを読めること");
    (sink, snapshot)
}
