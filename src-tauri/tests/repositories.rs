//! リポジトリの素性判定とフォルダスキャンの結合テスト（T-02）。
//!
//! 生成済みリポジトリの用意は [`common`] を見ること。

mod common;

use gitpeek_lib::git::repo::{
    probe, probe_all, scan, HeadState, RepositoryProbe, DEFAULT_EXCLUDED, DEFAULT_MAX_DEPTH,
};

use common::{fixtures, log};

fn probe_fixture(name: &str) -> RepositoryProbe {
    probe(&log(), "git", &fixtures().join(name))
}

#[test]
fn detects_a_branch_head() {
    let probe = probe_fixture("linear");
    assert!(probe.is_repository, "{:?}", probe.error);
    assert!(!probe.is_bare);
    assert!(!probe.is_shallow);
    assert!(!probe.index_lock_present);
    assert_eq!(
        probe.work_tree.as_deref().map(str::to_lowercase),
        Some(
            fixtures()
                .join("linear")
                .display()
                .to_string()
                .replace('\\', "/")
                .to_lowercase()
        )
    );

    match probe.head.expect("HEAD があること") {
        HeadState::Branch { name, sha } => {
            assert_eq!(name, "main");
            assert_eq!(sha.len(), 40, "{sha}");
        }
        other => panic!("ブランチ上のはずが {other:?}"),
    }
}

#[test]
fn detects_a_detached_head() {
    let probe = probe_fixture("detached");
    assert!(probe.is_repository, "{:?}", probe.error);
    assert!(
        matches!(probe.head, Some(HeadState::Detached { .. })),
        "{:?}",
        probe.head
    );
}

#[test]
fn detects_an_unborn_head() {
    let probe = probe_fixture("empty");
    assert!(probe.is_repository, "{:?}", probe.error);
    match probe.head.expect("HEAD があること") {
        // コミット 0 件でもブランチ名は決まっている。
        HeadState::Unborn { name } => assert_eq!(name, "main"),
        other => panic!("unborn のはずが {other:?}"),
    }
}

#[test]
fn detects_a_bare_repository() {
    let probe = probe_fixture("bare.git");
    assert!(probe.is_repository, "{:?}", probe.error);
    assert!(probe.is_bare);
    assert_eq!(probe.work_tree, None, "bare に作業ツリーは無い");
    assert!(matches!(probe.head, Some(HeadState::Branch { .. })));
}

#[test]
fn reports_a_non_repository_without_failing() {
    let path = fixtures().join("not-a-repo");
    std::fs::create_dir_all(&path).unwrap();

    let probe = probe(&log(), "git", &path);
    assert!(!probe.is_repository);
    assert_eq!(probe.git_dir, None);
    assert!(probe.head.is_none());
    assert!(
        probe.error.is_some_and(|error| error.contains("リポジトリ")),
        "理由を人間向けに返すこと"
    );
}

#[test]
fn reports_a_missing_path_without_failing() {
    let probe = probe(&log(), "git", &fixtures().join("does-not-exist"));
    assert!(!probe.is_repository);
    assert!(probe.error.is_some());
}

#[test]
fn reports_an_index_lock_without_removing_it() {
    // テストは並列に走るので、他のテストが probe しないリポジトリを使う。
    let repo = fixtures().join("merges");
    let lock = repo.join(".git").join("index.lock");
    std::fs::write(&lock, "").unwrap();

    let probe = probe(&log(), "git", &repo);
    assert!(probe.index_lock_present);
    assert!(lock.is_file(), "アプリから index.lock を消してはいけない");

    // 後続のテストへ影響させない。
    std::fs::remove_file(&lock).unwrap();
}

/// まとめて調べる（T-44）。**並列に終わっても、渡した順のまま返す。**
///
/// `merges` は index.lock のテストが使うので入れない（テストは並列に走る）。
fn probe_all_targets() -> Vec<std::path::PathBuf> {
    ["linear", "does-not-exist", "detached", "bare.git", "empty", "japanese"]
        .iter()
        .map(|name| fixtures().join(name))
        .collect()
}

/// 比べやすい形にする（ブランチ名・detached・bare・無い、の 4 つで足りる）。
fn summary(probe: &Option<RepositoryProbe>) -> String {
    match probe {
        None => "無い".to_string(),
        Some(probe) => format!(
            "repo={} bare={} head={:?}",
            probe.is_repository, probe.is_bare, probe.head
        ),
    }
}

#[test]
fn probes_all_in_the_given_order() {
    let paths = probe_all_targets();
    let probes = probe_all(&log(), "git", &paths, 4);

    assert_eq!(probes.len(), paths.len());
    // 1 件ずつ調べたものと、同じ位置に同じ結果が来ること。**フォルダが無いものは git を呼ばず None。**
    for (path, got) in paths.iter().zip(&probes) {
        let expected = path.is_dir().then(|| probe(&log(), "git", path));
        assert_eq!(summary(got), summary(&expected), "{}", path.display());
    }
    assert!(probes[1].is_none(), "無いフォルダは None");
    assert!(probes[3].as_ref().is_some_and(|probe| probe.is_bare), "4 件目は bare");
}

#[test]
fn probes_all_the_same_with_one_worker() {
    let paths = probe_all_targets();
    let one: Vec<String> = probe_all(&log(), "git", &paths, 1).iter().map(summary).collect();
    let many: Vec<String> = probe_all(&log(), "git", &paths, 8).iter().map(summary).collect();
    assert_eq!(one, many);
}

#[test]
fn probes_nothing_when_nothing_is_registered() {
    assert!(probe_all(&log(), "git", &[], 8).is_empty());
}

#[test]
fn handles_japanese_paths() {
    let probe = probe_fixture("japanese");
    assert!(probe.is_repository, "{:?}", probe.error);
    assert!(matches!(probe.head, Some(HeadState::Branch { .. })));
    assert!(
        probe.git_dir.is_some_and(|dir| dir.contains("japanese")),
        "git-dir が壊れずに返ること"
    );
}

#[test]
fn scans_the_generated_repositories() {
    let found = scan(fixtures(), DEFAULT_MAX_DEPTH, DEFAULT_EXCLUDED);
    let names: Vec<String> = found
        .iter()
        .filter_map(|path| path.file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .collect();

    for expected in [
        "linear",
        "branch-merge",
        "merges",
        "octopus",
        "two-roots",
        "japanese",
        "empty-subject",
        "empty",
        "detached",
    ] {
        assert!(names.contains(&expected.to_string()), "{expected} が無い: {names:?}");
    }

    // bare は `.git` を持たないのでスキャンでは見つからない（手動で登録する）。
    assert!(!names.contains(&"bare.git".to_string()), "{names:?}");
}

/// 記録先にはコマンドが積まれ、固定オプションも残っている。
#[test]
fn records_every_git_invocation() {
    let log = log();
    let probe = probe(&log, "git", &fixtures().join("linear"));
    assert!(probe.is_repository);

    let entries = log.entries();
    assert!(entries.len() >= 3, "rev-parse / symbolic-ref / rev-parse");
    assert!(entries.iter().all(|entry| entry
        .fixed_args
        .iter()
        .any(|arg| arg == "core.quotepath=false")));
}
