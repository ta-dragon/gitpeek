//! 結合テスト共通の道具立て。
//!
//! `scripts/make-test-repos.sh` が生成したリポジトリを使う（docs/DESIGN.md §14.3）。
//! 手元の実リポジトリには依存しない。
//!
//! ここは `src-tauri/src` の外なので `Command::new` を使ってよい。**src の中で
//! git 以外のプロセスを起動しないこと**（CLAUDE.md §2 のチョークポイント）。
//!
//! 生成はテストバイナリごとに 1 度走る。cargo はテストバイナリを直列に実行するので、
//! 別バイナリの生成と衝突しない。

// テストバイナリごとに使う道具が違うので、片方で未使用でも警告にしない。
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use gitpeek_lib::commandlog::CommandLog;

/// テストの記録先。イベントを送らないので `AppHandle` が要らない。
pub fn log() -> CommandLog {
    CommandLog::default()
}

pub fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Windows の PATH 上の `bash` は WSL のことがある。WSL の bash に Windows のパスを
/// 渡すと別の世界のパスとして解釈されて動かないので、**git に付属する bash を探す**。
/// 見つからないときだけ PATH の `bash` に委ねる。`GIT_BASH` で明示指定もできる。
pub fn bash() -> PathBuf {
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
pub fn fixtures() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        // **リポジトリの外**へ置く。git の管理下に作ると「リポジトリでないパス」の
        // テストが親リポジトリを拾ってしまう。
        let root = std::env::temp_dir().join("gitpeek-test-repos");
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

pub fn slashed(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}
