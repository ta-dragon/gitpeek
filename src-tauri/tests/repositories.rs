//! `scripts/make-test-repos.sh` が生成したリポジトリに対する結合テスト。
//!
//! 手元の実リポジトリには依存しない（docs/DESIGN.md §14.3）。
//! 生成は 1 度だけ行い、以降のテストは同じ出力ディレクトリを共有する。
//!
//! ここは `src-tauri/src` の外なので `Command::new` を使ってよい。**src の中で
//! git 以外のプロセスを起動しないこと**（CLAUDE.md §2 のチョークポイント）。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use givsoner_lib::commandlog::CommandLog;
use givsoner_lib::git::repo::{
    probe, scan, HeadState, RepositoryProbe, DEFAULT_EXCLUDED, DEFAULT_MAX_DEPTH,
};

/// テストの記録先。イベントを送らないので `AppHandle` が要らない。
fn log() -> CommandLog {
    CommandLog::default()
}

fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Windows の PATH 上の `bash` は WSL のことがある。WSL の bash に Windows のパスを
/// 渡すと別の世界のパスとして解釈されて動かないので、**git に付属する bash を探す**。
/// 見つからないときだけ PATH の `bash` に委ねる。`GIT_BASH` で明示指定もできる。
fn bash() -> PathBuf {
    if let Ok(explicit) = std::env::var("GIT_BASH") {
        return PathBuf::from(explicit);
    }

    #[cfg(windows)]
    {
        // <install>\cmd\git.exe -> <install>\bin\bash.exe
        let from_path = find_on_path("git.exe")
            .and_then(|git| git.parent().and_then(Path::parent).map(Path::to_path_buf))
            .map(|install| install.join("bin").join("bash.exe"));

        // PATH が POSIX 形式（msys シェル経由）だと上の探索が空振りするので、
        // 既定のインストール先も見る。
        let well_known = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(|dir| PathBuf::from(dir).join("Git").join("bin").join("bash.exe"));

        if let Some(found) = from_path
            .into_iter()
            .chain(well_known)
            .find(|candidate| candidate.is_file())
        {
            return found;
        }
    }

    PathBuf::from("bash")
}

#[cfg(windows)]
fn find_on_path(program: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

/// 生成済みのリポジトリ置き場。最初に触ったテストが生成する。
fn fixtures() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        // **リポジトリの外**へ置く。git の管理下に作ると「リポジトリでないパス」の
        // テストが親リポジトリを拾ってしまう。
        let root = std::env::temp_dir().join("givsoner-test-repos");
        let script = crate_root()
            .parent()
            .expect("リポジトリのルート")
            .join("scripts")
            .join("make-test-repos.sh");

        // Git Bash（msys）へ Windows 形式のパスを渡すと `\` がエスケープとして食われる。
        // スラッシュ区切りにして渡す。
        let output = Command::new(bash())
            .arg(slashed(&script))
            .arg(slashed(&root))
            .output()
            .unwrap_or_else(|error| panic!("{} を実行できません: {error}", script.display()));

        assert!(
            output.status.success(),
            "make-test-repos.sh が失敗しました:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        root
    })
}

fn slashed(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

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
