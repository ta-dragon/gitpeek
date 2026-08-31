//! git の検出とバージョン確認。
//!
//! 本アプリは git がインストールされている環境でのみ動作する（docs/DESIGN.md §3.4）。
//! 見つからない場合・古すぎる場合は専用画面で導線を出す。

use serde::Serialize;
use tauri::AppHandle;

use crate::commandlog::CommandLog;
use crate::git::exec;

/// 要求する最低バージョン。
pub const MIN_MAJOR: u32 = 2;
pub const MIN_MINOR: u32 = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// git を起動できたか。
    pub found: bool,
    /// 実際に起動を試みたプログラム名またはフルパス。
    pub path: String,
    /// `git version ` を取り除いたバージョン文字列。
    pub version: Option<String>,
    /// 最低バージョンを満たすか。
    pub version_ok: bool,
    pub min_version: String,
    /// 人間向けのエラーメッセージ。生の stderr はコマンドログ側に残る。
    pub error: Option<String>,
}

impl GitStatus {
    /// アプリを先へ進めてよい状態か。
    pub fn usable(&self) -> bool {
        self.found && self.version_ok
    }
}

pub fn detect(app: &AppHandle, log: &CommandLog, program: &str) -> GitStatus {
    let min_version = format!("{MIN_MAJOR}.{MIN_MINOR}");
    let unusable = |version: Option<String>, error: String, found: bool| GitStatus {
        found,
        path: program.to_string(),
        version,
        version_ok: false,
        min_version: min_version.clone(),
        error: Some(error),
    };

    let output = match exec::run(app, log, program, None, &["--version"]) {
        Ok(output) => output,
        Err(error) => return unusable(None, error, false),
    };

    if !output.ok() {
        return unusable(None, output.stderr, false);
    }

    let raw = output.stdout_lossy();
    let Some(version) = parse_version(&raw) else {
        return unusable(
            Some(raw.trim().to_string()),
            "バージョン文字列を解釈できませんでした".to_string(),
            true,
        );
    };

    GitStatus {
        found: true,
        path: program.to_string(),
        version_ok: meets_minimum(&version),
        version: Some(version),
        min_version,
        error: None,
    }
}

/// `git version 2.43.0.windows.1` -> `2.43.0.windows.1`
pub fn parse_version(raw: &str) -> Option<String> {
    raw.trim()
        .strip_prefix("git version ")
        .map(|rest| rest.trim().to_string())
        .filter(|rest| !rest.is_empty())
}

pub fn meets_minimum(version: &str) -> bool {
    let mut segments = version.split('.').map(|segment| {
        segment
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse::<u32>()
            .unwrap_or(0)
    });
    let major = segments.next().unwrap_or(0);
    let minor = segments.next().unwrap_or(0);
    (major, minor) >= (MIN_MAJOR, MIN_MINOR)
}

#[cfg(test)]
mod tests {
    use super::{meets_minimum, parse_version};

    #[test]
    fn parses_windows_version() {
        assert_eq!(
            parse_version("git version 2.43.0.windows.1\n").as_deref(),
            Some("2.43.0.windows.1")
        );
    }

    #[test]
    fn parses_plain_version() {
        assert_eq!(
            parse_version("git version 2.20.0").as_deref(),
            Some("2.20.0")
        );
    }

    #[test]
    fn rejects_unexpected_output() {
        assert_eq!(parse_version("not a git version"), None);
        assert_eq!(parse_version("git version "), None);
    }

    #[test]
    fn compares_against_minimum() {
        assert!(meets_minimum("2.43.0.windows.1"));
        assert!(meets_minimum("2.20.0"));
        assert!(meets_minimum("3.0.0"));
        assert!(!meets_minimum("2.19.9"));
        assert!(!meets_minimum("1.9.5"));
    }
}
