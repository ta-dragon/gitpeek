//! JSON ファイルのアトミック書き込み。
//!
//! 設定と UI 状態はアプリの生存中に何度も上書きされる。書き込み途中で落ちると
//! 「壊れた JSON」が残り、次回起動で退避・再生成の対象になってしまう。
//! そのため **同ディレクトリの一時ファイルへ書いてから `rename` する**
//! （docs/DESIGN.md §12.1、CLAUDE.md §5）。

use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// `path` と同じディレクトリに置く一時ファイルのパス。
/// 別ドライブや別ディレクトリだと `rename` がアトミックにならない。
fn temp_path(path: &Path) -> Option<PathBuf> {
    let dir = path.parent()?;
    let mut name = OsString::from(path.file_name()?);
    name.push(".tmp");
    Some(dir.join(name))
}

/// 文字列をアトミックに書き込む。
pub fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let temp = temp_path(path)
        .ok_or_else(|| format!("書き込み先を決定できません: {}", path.display()))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| {
            format!("ディレクトリを作成できません ({}): {error}", dir.display())
        })?;
    }

    let write = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(contents.as_bytes())?;
        // rename の前に確実にディスクへ出す。ここを省くと電源断で空ファイルが残りうる。
        file.sync_all()
    })();

    if let Err(error) = write {
        let _ = fs::remove_file(&temp);
        return Err(format!(
            "一時ファイルへ書き込めません ({}): {error}",
            temp.display()
        ));
    }

    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("ファイルを更新できません ({}): {error}", path.display())
    })
}

/// 値を整形済み JSON としてアトミックに書き込む。
/// `settings.json` は手編集を想定しているので必ず整形して書く（CLAUDE.md §5）。
pub fn write_pretty<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(value)
        .map_err(|error| format!("JSON へ変換できません: {error}"))?;
    text.push('\n');
    write_atomic(path, &text)
}

#[cfg(test)]
mod tests {
    use super::{temp_path, write_atomic, write_pretty};
    use std::path::Path;

    #[test]
    fn temp_file_sits_next_to_the_target() {
        let temp = temp_path(Path::new("/root/settings.json")).unwrap();
        assert_eq!(temp.parent(), Some(Path::new("/root")));
        assert_eq!(temp.file_name().unwrap(), "settings.json.tmp");
    }

    #[test]
    fn writes_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        write_atomic(&path, "{}\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}\n");
    }

    #[test]
    fn overwrites_existing_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        write_pretty(&path, &serde_json::json!({ "a": 1 })).unwrap();
        write_pretty(&path, &serde_json::json!({ "a": 2 })).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"a\": 2"), "{text}");
        assert!(text.ends_with('\n'));
        assert!(!dir.path().join("state.json.tmp").exists());
    }
}
