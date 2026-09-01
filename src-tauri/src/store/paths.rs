//! `%APPDATA%\com.tatsu.givsoner\` のレイアウト解決。
//!
//! パスは必ず Tauri の `app_data_dir()` から解決する。**OneDrive 配下に設定を置かない**
//! （CLAUDE.md §5）。作業ディレクトリが OneDrive 配下にあるため相対パスで組み立てると
//! 同期競合とファイルロックを踏む。
//!
//! レイアウト（docs/DESIGN.md §12.1）:
//!
//! ```text
//! %APPDATA%\com.tatsu.givsoner\
//! ├── settings.json
//! ├── state.json
//! ├── skills\
//! ├── reviews\<repo-id>\
//! └── logs\
//! ```

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// データディレクトリのレイアウト。
///
/// `AppHandle` を持たないので、テストでは `new()` に一時ディレクトリを渡せる。
#[derive(Debug, Clone)]
pub struct StorePaths {
    root: PathBuf,
}

impl StorePaths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Tauri の `app_data_dir()`（Windows では `%APPDATA%\<identifier>`）から解決する。
    pub fn from_app(app: &AppHandle) -> Result<Self, String> {
        app.path()
            .app_data_dir()
            .map(Self::new)
            .map_err(|error| format!("データディレクトリを解決できません: {error}"))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 手編集を想定した設定。
    pub fn settings_file(&self) -> PathBuf {
        self.root.join("settings.json")
    }

    /// 壊れた `settings.json` の退避先。黙って捨てないための保険（CLAUDE.md §5）。
    pub fn settings_backup_file(&self) -> PathBuf {
        self.root.join("settings.json.bak")
    }

    /// アプリが随時上書きする UI 状態。壊れたら捨てて再生成してよい。
    pub fn state_file(&self) -> PathBuf {
        self.root.join("state.json")
    }

    /// グローバル skill (*.md)。
    pub fn skills_dir(&self) -> PathBuf {
        self.root.join("skills")
    }

    pub fn reviews_dir(&self) -> PathBuf {
        self.root.join("reviews")
    }

    /// リポジトリごとのレビュー結果。上書きせず履歴として積む（docs/DESIGN.md §12.4）。
    pub fn review_dir(&self, repository_id: &str) -> PathBuf {
        self.reviews_dir().join(repository_id)
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    /// ディレクトリ一式を用意する。既に在れば何もしない。
    pub fn ensure(&self) -> Result<(), String> {
        for dir in [
            self.root.clone(),
            self.skills_dir(),
            self.reviews_dir(),
            self.logs_dir(),
        ] {
            fs::create_dir_all(&dir).map_err(|error| {
                format!("ディレクトリを作成できません ({}): {error}", dir.display())
            })?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::StorePaths;

    #[test]
    fn resolves_layout_under_root() {
        let paths = StorePaths::new("/root");
        assert_eq!(paths.settings_file(), std::path::Path::new("/root/settings.json"));
        assert_eq!(
            paths.settings_backup_file(),
            std::path::Path::new("/root/settings.json.bak")
        );
        assert_eq!(paths.state_file(), std::path::Path::new("/root/state.json"));
        assert_eq!(paths.skills_dir(), std::path::Path::new("/root/skills"));
        assert_eq!(paths.logs_dir(), std::path::Path::new("/root/logs"));
        assert_eq!(
            paths.review_dir("abc"),
            std::path::Path::new("/root/reviews/abc")
        );
    }

    #[test]
    fn ensure_creates_all_directories() {
        let dir = tempfile::tempdir().unwrap();
        let paths = StorePaths::new(dir.path().join("com.tatsu.givsoner"));
        paths.ensure().unwrap();
        paths.ensure().unwrap(); // 二度目でも失敗しない

        assert!(paths.root().is_dir());
        assert!(paths.skills_dir().is_dir());
        assert!(paths.reviews_dir().is_dir());
        assert!(paths.logs_dir().is_dir());
    }
}
