//! リポジトリの素性判定とフォルダスキャン。
//!
//! 判定は git に聞く（`rev-parse` / `symbolic-ref`）。ただし **`index.lock` だけは
//! ファイルシステムを直接見る**。git を呼ぶと lock を掴んでいる相手と競合しうるうえ、
//! **アプリからは絶対に削除しない**（CLAUDE.md §2）ので、存在を報告するだけでよい。
//!
//! スキャンは git を呼ばず、`.git` の有無だけで判断する。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commandlog::LogSink;
use crate::git::exec;
use crate::store::settings::RepositorySettings;

/// フォルダスキャンの既定の深さ。
pub const DEFAULT_MAX_DEPTH: usize = 4;

/// フォルダスキャンで降りないディレクトリ名。
pub const DEFAULT_EXCLUDED: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    ".venv",
    ".next",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryProbe {
    pub is_repository: bool,
    pub git_dir: Option<String>,
    /// bare では `None`。
    pub work_tree: Option<String>,
    pub is_bare: bool,
    pub is_shallow: bool,
    pub head: Option<HeadState>,
    /// 検出するだけ。**アプリから削除しない**（CLAUDE.md §2）。
    pub index_lock_present: bool,
    /// 人間向けのメッセージ。生の stderr はコマンドログ側に残る。
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HeadState {
    Branch { name: String, sha: String },
    Detached { sha: String },
    /// コミット 0 件。ブランチ名だけが決まっている状態。
    Unborn { name: String },
}

/// `RepositorySettings` に実際の状態を添えたもの。一覧表示はこれを使う。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryEntry {
    #[serde(flatten)]
    pub settings: RepositorySettings,
    /// パスが消えているリポジトリは `None`。UI 側でグレーアウトする。
    pub probe: Option<RepositoryProbe>,
}

impl RepositoryProbe {
    fn not_a_repository(error: Option<String>) -> Self {
        Self {
            is_repository: false,
            git_dir: None,
            work_tree: None,
            is_bare: false,
            is_shallow: false,
            head: None,
            index_lock_present: false,
            error,
        }
    }
}

/// リポジトリかどうかと、その素性を調べる。
///
/// git が起動できない・リポジトリでない場合も `Err` にはせず、
/// `is_repository: false` と理由を返す。呼び出し側は一覧の 1 行を描くだけでよい。
pub fn probe(log: &dyn LogSink, program: &str, path: &Path) -> RepositoryProbe {
    if !path.is_dir() {
        return RepositoryProbe::not_a_repository(Some(format!(
            "フォルダが見つかりません: {}",
            path.display()
        )));
    }

    // `--absolute-git-dir` を使うのは、`--git-dir` が作業ツリーでは相対パス `.git`、
    // bare では `.` を返し、呼び出し側で連結し直す必要があるため。
    let flags = match exec::run(
        log,
        program,
        Some(path),
        &[
            "rev-parse",
            "--absolute-git-dir",
            "--is-bare-repository",
            "--is-shallow-repository",
        ],
    ) {
        Ok(output) if output.ok() => output.stdout_lossy(),
        Ok(output) => {
            // git は起動したがリポジトリではない（exit 128 など）。
            return RepositoryProbe::not_a_repository(Some(human_error(&output.stderr, path)));
        }
        Err(error) => return RepositoryProbe::not_a_repository(Some(error)),
    };

    let Some((git_dir, is_bare, is_shallow)) = parse_rev_parse_flags(&flags) else {
        return RepositoryProbe::not_a_repository(Some(
            "git rev-parse の出力を解釈できませんでした".to_string(),
        ));
    };

    // bare では作業ツリーが無く `--show-toplevel` が失敗するので、そもそも呼ばない。
    let work_tree = if is_bare {
        None
    } else {
        exec::run(log, program, Some(path), &["rev-parse", "--show-toplevel"])
            .ok()
            .filter(exec::GitOutput::ok)
            .map(|output| output.stdout_lossy().trim().to_string())
            .filter(|value| !value.is_empty())
    };

    let index_lock_present = Path::new(&git_dir).join("index.lock").is_file();

    RepositoryProbe {
        is_repository: true,
        head: read_head(log, program, path),
        git_dir: Some(git_dir),
        work_tree,
        is_bare,
        is_shallow,
        index_lock_present,
        error: None,
    }
}

/// HEAD の 3 状態を判別する。
///
/// - `symbolic-ref` 成功 ＋ `rev-parse` 成功 → ブランチ上
/// - `symbolic-ref` 失敗 ＋ `rev-parse` 成功 → detached
/// - `symbolic-ref` 成功 ＋ `rev-parse` 失敗 → コミット 0 件（unborn）
///
/// どちらも失敗した場合は `None`。**これは unborn ではない**（リポジトリが壊れている等）。
pub fn read_head(log: &dyn LogSink, program: &str, path: &Path) -> Option<HeadState> {
    let branch = exec::run(
        log,
        program,
        Some(path),
        &["symbolic-ref", "-q", "--short", "HEAD"],
    )
    .ok()
    .filter(exec::GitOutput::ok)
    .map(|output| output.stdout_lossy().trim().to_string())
    .filter(|value| !value.is_empty());

    let sha = exec::run(log, program, Some(path), &["rev-parse", "-q", "--verify", "HEAD"])
        .ok()
        .filter(exec::GitOutput::ok)
        .map(|output| output.stdout_lossy().trim().to_string())
        .filter(|value| !value.is_empty());

    match (branch, sha) {
        (Some(name), Some(sha)) => Some(HeadState::Branch { name, sha }),
        (None, Some(sha)) => Some(HeadState::Detached { sha }),
        (Some(name), None) => Some(HeadState::Unborn { name }),
        (None, None) => None,
    }
}

/// `rev-parse --absolute-git-dir --is-bare-repository --is-shallow-repository` の 3 行。
fn parse_rev_parse_flags(stdout: &str) -> Option<(String, bool, bool)> {
    let mut lines = stdout.lines().map(str::trim);
    let git_dir = lines.next()?;
    let is_bare = lines.next()? == "true";
    let is_shallow = lines.next()? == "true";
    if git_dir.is_empty() {
        return None;
    }
    Some((git_dir.to_string(), is_bare, is_shallow))
}

/// git の stderr を画面向けの 1 行にする。生の stderr はコマンドログで見られる。
fn human_error(stderr: &str, path: &Path) -> String {
    let first = stderr.lines().find(|line| !line.trim().is_empty());
    match first {
        Some(line) if line.contains("not a git repository") => {
            format!("git リポジトリではありません: {}", path.display())
        }
        Some(line) => line.trim().to_string(),
        None => format!("git リポジトリではありません: {}", path.display()),
    }
}

/// `root` の下から git リポジトリを探す。
///
/// `.git` を持つディレクトリを見つけたら**そこで打ち切る**（入れ子のリポジトリは追わない）。
/// bare リポジトリは `.git` を持たないので見つからない。手動で登録する。
pub fn scan(root: &Path, max_depth: usize, excluded: &[&str]) -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk(root, 0, max_depth, excluded, &mut found);
    found.sort();
    found
}

fn walk(dir: &Path, depth: usize, max_depth: usize, excluded: &[&str], found: &mut Vec<PathBuf>) {
    // `.git` はディレクトリとは限らない（submodule やワークツリーではファイル）。
    if dir.join(".git").exists() {
        found.push(dir.to_path_buf());
        return;
    }
    if depth >= max_depth {
        return;
    }

    // 読めないディレクトリは黙って飛ばす。スキャンは best-effort でよい。
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        // シンボリックリンクと junction は辿らない。OneDrive 配下で循環を踏むため。
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }

        let name = entry.file_name();
        let name = name.to_string_lossy();
        if excluded.iter().any(|value| value.eq_ignore_ascii_case(&name)) {
            continue;
        }

        walk(&entry.path(), depth + 1, max_depth, excluded, found);
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_rev_parse_flags, scan, HeadState, DEFAULT_EXCLUDED, DEFAULT_MAX_DEPTH};
    use std::fs;
    use std::path::Path;

    /// `.git` を持つだけの偽リポジトリ。scan は git を呼ばないのでこれで足りる。
    fn fake_repo(path: &Path) {
        fs::create_dir_all(path.join(".git")).unwrap();
    }

    #[test]
    fn parses_rev_parse_flags() {
        assert_eq!(
            parse_rev_parse_flags("C:/repo/.git\nfalse\nfalse\n"),
            Some(("C:/repo/.git".to_string(), false, false))
        );
        assert_eq!(
            parse_rev_parse_flags("C:/repo.git\ntrue\ntrue\n"),
            Some(("C:/repo.git".to_string(), true, true))
        );
        assert_eq!(parse_rev_parse_flags("C:/repo/.git\nfalse\n"), None);
        assert_eq!(parse_rev_parse_flags(""), None);
    }

    #[test]
    fn head_state_serializes_with_a_kind_tag() {
        let json = serde_json::to_value(HeadState::Detached {
            sha: "abc".to_string(),
        })
        .unwrap();
        assert_eq!(json["kind"], "detached");
        assert_eq!(json["sha"], "abc");

        let json = serde_json::to_value(HeadState::Unborn {
            name: "main".to_string(),
        })
        .unwrap();
        assert_eq!(json["kind"], "unborn");
    }

    #[test]
    fn finds_repositories_and_stops_at_the_first_git() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fake_repo(&root.join("a"));
        // 入れ子のリポジトリは追わない。
        fake_repo(&root.join("a").join("nested"));
        fake_repo(&root.join("group").join("b"));
        fs::create_dir_all(root.join("group").join("not-a-repo")).unwrap();

        let found = scan(root, DEFAULT_MAX_DEPTH, DEFAULT_EXCLUDED);
        assert_eq!(found, vec![root.join("a"), root.join("group").join("b")]);
    }

    #[test]
    fn honours_the_depth_limit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fake_repo(&root.join("d1"));
        fake_repo(&root.join("d1x").join("d2").join("d3"));
        fake_repo(&root.join("e1").join("e2").join("e3").join("e4"));

        // 深さ 3 では 4 階層目のリポジトリに届かない。
        let found = scan(root, 3, DEFAULT_EXCLUDED);
        assert_eq!(
            found,
            vec![root.join("d1"), root.join("d1x").join("d2").join("d3")]
        );

        // 深さ 4 なら見つかる。
        let found = scan(root, 4, DEFAULT_EXCLUDED);
        assert!(found.contains(&root.join("e1").join("e2").join("e3").join("e4")));
    }

    #[test]
    fn skips_excluded_directories() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fake_repo(&root.join("node_modules").join("pkg"));
        fake_repo(&root.join("target").join("debug-repo"));
        fake_repo(&root.join("keep"));

        assert_eq!(
            scan(root, DEFAULT_MAX_DEPTH, DEFAULT_EXCLUDED),
            vec![root.join("keep")]
        );
        // 除外を空にすれば見つかる（除外は既定であって禁止ではない）。
        assert_eq!(scan(root, DEFAULT_MAX_DEPTH, &[]).len(), 3);
    }

    #[test]
    fn returns_nothing_for_a_missing_root() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        assert!(scan(&missing, DEFAULT_MAX_DEPTH, DEFAULT_EXCLUDED).is_empty());
    }
}
