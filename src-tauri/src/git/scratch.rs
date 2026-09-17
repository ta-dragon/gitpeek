//! git に書かせてよい一時フォルダ（T-37。docs/DESIGN.md §7.6）。
//!
//! `git merge-tree --write-tree` は結果の tree を**オブジェクトとして書く**。GitPeek は
//! リポジトリへ書き込まないので（CLAUDE.md §1）、`GIT_OBJECT_DIRECTORY` でここへ逸らす。
//! **CLAUDE.md §1 を緩める 4 件目**で、許されているのは**この一時フォルダへの書き込みだけ**。
//!
//! - 置き場所は OS の一時フォルダ（`%TEMP%`）。**OneDrive の下に作らない**（CLAUDE.md §5 と同じ理由）
//! - **`Drop` で必ず消す。** 判定が失敗しても、中止しても、panic しても残さない
//! - 落ちて残ったものは [`sweep_leftovers`] が消す。**自分の接頭辞で、しかも古いものだけ**
//!   （日常使いの GitPeek と開発版が同時に動いていると、相手が使用中のフォルダがある）

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

/// 一時フォルダの名前の接頭辞。**掃除はこれで始まるものにしか触らない。**
pub const PREFIX: &str = "gitpeek-merge-";

/// これより古い残りだけを掃除する。判定 1 回は 1 秒もかからないので、1 時間残っているものは
/// 使用中ではない。
const STALE_AFTER: Duration = Duration::from_secs(60 * 60);

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// 使い終わったら消える一時フォルダ。
#[derive(Debug)]
pub struct ScratchDir {
    path: PathBuf,
}

impl ScratchDir {
    /// OS の一時フォルダの下に作る。
    pub fn new() -> Result<Self, String> {
        Self::new_in(&std::env::temp_dir())
    }

    /// `parent` の下に作る。テストで置き場所を分けるため。
    pub fn new_in(parent: &Path) -> Result<Self, String> {
        // 同じ名前が既にあれば作り直す。`create_dir` は既存なら失敗するので、
        // **他人のフォルダを自分のものとして使い、消してしまう**ことが無い。
        for _ in 0..16 {
            let name = format!(
                "{PREFIX}{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_nanos())
                    .unwrap_or_default(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed),
            );
            let path = parent.join(name);
            match std::fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!("一時フォルダを作れません: {}: {error}", path.display()))
                }
            }
        }
        Err("一時フォルダの名前を決められません".to_string())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// 前回落ちて残った一時フォルダを消す。**消した数**を返す。
///
/// **接頭辞が [`PREFIX`] で、しかも [`STALE_AFTER`] より古いものだけ。** 消せなくても
/// アプリは止めない（次の起動でまた試す）。
pub fn sweep_leftovers() -> usize {
    sweep_in(&std::env::temp_dir(), STALE_AFTER, SystemTime::now())
}

/// [`sweep_leftovers`] の中身。置き場所と「いま」を渡せるようにしてテストする。
pub fn sweep_in(parent: &Path, stale_after: Duration, now: SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(PREFIX) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        // symlink を辿って外の中身を消さない。フォルダそのものだけを見る。
        if !metadata.is_dir() || entry.file_type().map(|kind| kind.is_symlink()).unwrap_or(true) {
            continue;
        }
        let old_enough = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= stale_after);
        if old_enough && std::fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::{sweep_in, ScratchDir, PREFIX};
    use std::time::{Duration, SystemTime};

    fn parent() -> tempfile::TempDir {
        tempfile::tempdir().expect("一時ディレクトリ")
    }

    #[test]
    fn is_removed_when_dropped() {
        let parent = parent();
        let path = {
            let scratch = ScratchDir::new_in(parent.path()).expect("作れること");
            std::fs::write(scratch.path().join("object"), b"x").expect("書けること");
            scratch.path().to_path_buf()
        };
        assert!(!path.exists(), "使い終わったのに残っている");
    }

    #[test]
    fn is_removed_even_when_the_work_panics() {
        let parent = parent();
        let base = parent.path().to_path_buf();
        let result = std::panic::catch_unwind(move || {
            let scratch = ScratchDir::new_in(&base).expect("作れること");
            std::fs::write(scratch.path().join("object"), b"x").expect("書けること");
            panic!("判定の途中で落ちた");
        });
        assert!(result.is_err());
        let left = std::fs::read_dir(parent.path()).expect("読めること").count();
        assert_eq!(left, 0, "落ちたのに残っている");
    }

    #[test]
    fn two_at_once_do_not_share_a_folder() {
        let parent = parent();
        let first = ScratchDir::new_in(parent.path()).expect("作れること");
        let second = ScratchDir::new_in(parent.path()).expect("作れること");
        assert_ne!(first.path(), second.path());
    }

    #[test]
    fn sweeping_removes_only_old_folders_with_our_prefix() {
        let parent = parent();
        let ours = parent.path().join(format!("{PREFIX}left-behind"));
        let others = parent.path().join("someone-else");
        // 接頭辞が同じでも**ファイル**は消さない（自分が作るのはフォルダだけ）。
        let a_file = parent.path().join(format!("{PREFIX}not-a-folder.txt"));
        std::fs::create_dir(&ours).expect("作れること");
        std::fs::create_dir(&others).expect("作れること");
        std::fs::write(&a_file, b"x").expect("書けること");

        // 作った直後は「新しい」ので消さない（別の GitPeek が使っているかもしれない）。
        assert_eq!(sweep_in(parent.path(), Duration::from_secs(3600), SystemTime::now()), 0);
        assert!(ours.exists());

        // 2 時間後なら古い。**他人のフォルダには触らない。**
        let later = SystemTime::now() + Duration::from_secs(2 * 3600);
        assert_eq!(sweep_in(parent.path(), Duration::from_secs(3600), later), 1);
        assert!(!ours.exists());
        assert!(others.exists(), "接頭辞の違うフォルダを消した");
        assert!(a_file.exists(), "接頭辞の同じファイルを消した");
    }
}
