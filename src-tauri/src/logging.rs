//! ログファイル（T-24。docs/DESIGN.md §13.3, §13.4）。
//!
//! `%APPDATA%\com.tatsu.givsoner\logs\givsoner-YYYY-MM-DD.log` に 1 行 1 イベントで書く。
//! Phase 6 以降の認証・checkout まわりは再現が難しく、後から追える記録が要る。
//!
//! ここが守っていること:
//!
//! - **書き出しの口は 1 つ**（[`format_line`]）。**そこで `redact` を通す**（CLAUDE.md §4）。
//!   2 か所から書くと、片方でマスクを忘れる（`commandlog.rs` が `record()` の中でだけ
//!   マスクしているのと同じ構造）
//! - **本文は書かない。** プロンプト・差分・レビュー本文・skill 本文を書くと、
//!   `%APPDATA%` に他人のソースと秘密が残る。LLM はメタ情報だけ
//! - **書けなくてもアプリを止めない。** 代わりに [`LogStatus`] で理由を画面へ 1 度出す
//!   （黙って落とすと「書いているつもり」になる）
//! - **消してよいのは自分が作った形のファイルだけ**（[`sweep`]）。フォルダに置かれた
//!   他のものには触らない
//!
//! **日付はアプリを起動した日で固定される**（割り切り）。プラグインは書き出し先を
//! 組み立てのときに決めるので、起動したまま日付をまたぐと同じファイルに書き続ける。
//! 掃除は次の起動で追いつく。

use std::fs;
use std::panic::PanicHookInfo;
use std::path::Path;

use chrono::{DateTime, Local, NaiveDate};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_log::{Target, TargetKind};

use crate::redact::redact;

/// ファイル名の頭。**掃除の対象を見分ける鍵**でもある。
const PREFIX: &str = "givsoner-";

/// 何日ぶん残すか（DESIGN.md §13.3）。**ちょうど 7 日は残す。**
pub const KEEP_DAYS: i64 = 7;

/// 1 ファイルの上限。超えると同じ日のファイルが `_<日時>` 付きで分かれる。
///
/// **プラグインの既定（40 KB）では 1 日に何度も分かれる。** git の stderr を
/// 全文残すと決めた以上（利用者の判断。2026-09-06）、1 日 1 本で収まる幅にする。
const MAX_FILE_SIZE: u128 = 8 * 1024 * 1024;

/// panic が起きたことをフロントへ知らせるイベント名。
pub const PANIC_EVENT: &str = "app-panic";

/// ログの状態。**書けていないことを画面に出す**ために返す（CLAUDE.md §6）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStatus {
    /// ログフォルダ。開くボタンと文言に使う。**空なら場所すら決まっていない。**
    pub dir: String,
    /// 書けているか。
    pub writing: bool,
    /// 書けていない理由。`None` なら書けている。
    pub problem: Option<String>,
}

/// その日のファイル名（拡張子なし）。
pub fn file_stem(today: NaiveDate) -> String {
    format!("{PREFIX}{}", today.format("%Y-%m-%d"))
}

/// ログ 1 行。**ここが唯一の書き出しの口で、`redact` を通す。**
///
/// 複数行のメッセージ（git の stderr など）は、**続きの行を字下げして 1 件に見せる**。
/// 頭の行だけ grep すれば一覧になり、読むときは塊で読める。
pub fn format_line(at: &DateTime<Local>, level: log::Level, target: &str, message: &str) -> String {
    let body = redact(message);
    let indented = body.replace('\n', "\n    ");
    format!(
        "{} {:<5} {} {indented}",
        at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        level,
        redact(target),
    )
}

/// panic の 1 行。**ペイロードも `redact` を通す**（メッセージに URL が乗りうる）。
pub fn panic_line(info: &PanicHookInfo<'_>) -> String {
    let payload = if let Some(text) = info.payload().downcast_ref::<&str>() {
        (*text).to_string()
    } else if let Some(text) = info.payload().downcast_ref::<String>() {
        text.clone()
    } else {
        "（内容を読めない panic）".to_string()
    };
    panic_text(
        &payload,
        info.location()
            .map(|at| format!("{}:{}:{}", at.file(), at.line(), at.column())),
    )
}

/// 組み立てだけを取り出したもの。**`PanicHookInfo` は自分では作れない**ので、
/// テストはこちらに当てる（グローバルな panic hook を差し替えずに済む）。
fn panic_text(payload: &str, at: Option<String>) -> String {
    let where_at = at.unwrap_or_else(|| "場所不明".to_string());
    redact(&format!("panic at {where_at}: {payload}"))
}

/// ログ用のプラグイン。**書き出し先はこのアプリのデータフォルダに固定する。**
///
/// プラグイン既定の `LogDir` は Windows では `%LOCALAPPDATA%` を指すので使わない
/// （置き場所は `%APPDATA%\com.tatsu.givsoner\logs\` と決めてある。CLAUDE.md §5）。
pub fn plugin<R: Runtime>(logs_dir: &Path, today: NaiveDate) -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_log::Builder::new()
        .target(Target::new(TargetKind::Folder {
            path: logs_dir.to_path_buf(),
            file_name: Some(file_stem(today)),
        }))
        .max_file_size(MAX_FILE_SIZE)
        // **古いものを消すのはこちらの掃除（7 日）だけ。** プラグインには消させない。
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
        .level(log::LevelFilter::Info)
        // 依存が吐く細かい記録まで載せると、自分の記録が埋もれる。
        .level_for("ureq", log::LevelFilter::Warn)
        .level_for("rustls", log::LevelFilter::Warn)
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("wry", log::LevelFilter::Warn)
        .format(|out, message, record| {
            out.finish(format_args!(
                "{}",
                format_line(&Local::now(), record.level(), record.target(), &message.to_string())
            ))
        })
        .build()
}

/// 古いログを消す。**消した数**を返す。
///
/// **自分が作った形のファイルだけを見る**（`givsoner-YYYY-MM-DD` で始まり `.log` で
/// 終わるもの。プラグインが分けた `_<日時>` 付きと `.bak` も同じ頭を持つ）。
/// フォルダに置かれた他のものには触らない。
///
/// **消せなくても失敗にしない。** ログの掃除でアプリを止める理由が無い。
pub fn sweep(logs_dir: &Path, today: NaiveDate, keep_days: i64) -> usize {
    let Ok(listing) = fs::read_dir(logs_dir) else {
        return 0;
    };

    let mut removed = 0;
    for entry in listing.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(date) = dated(&name) else { continue };
        if (today - date).num_days() > keep_days && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// ファイル名から日付を読む。**形が違えば `None`**（＝触らない）。
fn dated(name: &str) -> Option<NaiveDate> {
    if !(name.ends_with(".log") || name.ends_with(".log.bak")) {
        return None;
    }
    let rest = name.strip_prefix(PREFIX)?;
    // 頭の `YYYY-MM-DD` だけ見る。プラグインが分けた `_<日時>` は後ろに付く。
    let head = rest.get(..10)?;
    NaiveDate::parse_from_str(head, "%Y-%m-%d").ok()
}

/// panic を捕まえてログへ書き、フロントへ知らせる。
///
/// **既定の挙動（標準エラーへの出力）は残す。** 消すと `tauri dev` の画面から
/// 手掛かりが消える。
pub fn install_panic_hook<R: Runtime>(app: AppHandle<R>) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let line = panic_line(info);
        log::error!(target: "panic", "{line}");
        let _ = app.emit(PANIC_EVENT, PanicEvent { message: redact(&line) });
        previous(info);
    }));
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PanicEvent {
    message: String,
}

/// ログフォルダのパス（画面に出す用）。
pub fn dir_display(logs_dir: &Path) -> String {
    logs_dir.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::{dated, file_stem, format_line, panic_text, sweep, KEEP_DAYS};
    use chrono::{Local, NaiveDate, TimeZone};
    use std::fs;

    fn day(text: &str) -> NaiveDate {
        NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn names_the_file_by_the_day() {
        assert_eq!(file_stem(day("2026-09-06")), "givsoner-2026-09-06");
    }

    /// **平文の資格情報が 1 文字も出ない。** 書き出しの口はここだけなので、
    /// ここを通れば画面と同じ規則が効く（CLAUDE.md §4）。
    #[test]
    fn masks_credentials_in_the_line() {
        let at = Local.with_ymd_and_hms(2026, 9, 6, 15, 32, 10).unwrap();
        let line = format_line(
            &at,
            log::Level::Warn,
            "git",
            "fatal: https://tatsu:ghp_abcdefghijklmnopqrstuvwxyz012345@github.com/o/r.git",
        );
        assert!(!line.contains("ghp_abcdefghijklmnopqrstuvwxyz012345"));
        assert!(line.contains("tatsu:***@github.com"));
        assert!(line.contains("WARN"));
        assert!(line.contains("git"));
    }

    /// **続きの行は字下げする。** 頭の行だけ grep すれば一覧になる。
    #[test]
    fn indents_continuation_lines() {
        let at = Local.with_ymd_and_hms(2026, 9, 6, 15, 32, 10).unwrap();
        let line = format_line(&at, log::Level::Info, "git", "1 行目\n2 行目");
        let lines: Vec<&str> = line.split('\n').collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with("1 行目"));
        assert_eq!(lines[1], "    2 行目");
    }

    #[test]
    fn reads_the_date_from_our_own_names() {
        assert_eq!(dated("givsoner-2026-09-06.log"), Some(day("2026-09-06")));
        // プラグインが大きさで分けたもの。
        assert_eq!(
            dated("givsoner-2026-09-06_2026-09-06_15-32-10.log"),
            Some(day("2026-09-06"))
        );
        assert_eq!(
            dated("givsoner-2026-09-06_2026-09-06_15-32-10.log.bak"),
            Some(day("2026-09-06"))
        );
    }

    /// **形が違うものは見ない。** ＝ 掃除の対象にならない。
    #[test]
    fn ignores_other_names() {
        assert_eq!(dated("givsoner.log"), None);
        assert_eq!(dated("givsoner-2026-09-06.txt"), None);
        assert_eq!(dated("メモ.log"), None);
        assert_eq!(dated("givsoner-いつか.log"), None);
        assert_eq!(dated(""), None);
    }

    /// **ちょうど 7 日は残し、8 日から消す**（端の値）。
    #[test]
    fn removes_only_what_is_older_than_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let today = day("2026-09-10");
        for name in [
            "givsoner-2026-09-10.log", // 今日
            "givsoner-2026-09-03.log", // ちょうど 7 日
            "givsoner-2026-09-02.log", // 8 日 → 消える
            "givsoner-2026-08-01.log", // ずっと前 → 消える
        ] {
            fs::write(dir.path().join(name), "x").unwrap();
        }

        assert_eq!(sweep(dir.path(), today, KEEP_DAYS), 2);
        assert!(dir.path().join("givsoner-2026-09-10.log").exists());
        assert!(dir.path().join("givsoner-2026-09-03.log").exists());
        assert!(!dir.path().join("givsoner-2026-09-02.log").exists());
        assert!(!dir.path().join("givsoner-2026-08-01.log").exists());
    }

    /// **自分が置いていないファイルには触らない。**
    #[test]
    fn leaves_foreign_files_alone() {
        let dir = tempfile::tempdir().unwrap();
        let today = day("2026-09-10");
        fs::write(dir.path().join("たいせつなメモ.txt"), "x").unwrap();
        fs::write(dir.path().join("givsoner.log"), "x").unwrap();
        fs::write(dir.path().join("other-2020-01-01.log"), "x").unwrap();
        fs::create_dir(dir.path().join("givsoner-2020-01-01.log")).unwrap();

        assert_eq!(sweep(dir.path(), today, KEEP_DAYS), 0);
        assert!(dir.path().join("たいせつなメモ.txt").exists());
        assert!(dir.path().join("givsoner.log").exists());
        assert!(dir.path().join("other-2020-01-01.log").exists());
        // 同じ名前のディレクトリも消さない（ファイルだけを見る）。
        assert!(dir.path().join("givsoner-2020-01-01.log").is_dir());
    }

    /// **フォルダが無くても落ちない。** ログのために起動を止めない。
    #[test]
    fn a_missing_folder_is_not_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(sweep(&dir.path().join("なし"), day("2026-09-10"), KEEP_DAYS), 0);
    }

    /// panic の内容も `redact` を通る。**組み立てだけを見る**ので、
    /// グローバルな panic hook を差し替えない（他のテストの panic を横取りしない）。
    #[test]
    fn masks_credentials_in_a_panic() {
        let line = panic_text(
            "https://tatsu:ghp_abcdefghijklmnopqrstuvwxyz012345@github.com で落ちた",
            Some("src/git/exec.rs:42:9".to_string()),
        );
        assert!(line.starts_with("panic at src/git/exec.rs:42:9: "));
        assert!(!line.contains("ghp_abcdefghijklmnopqrstuvwxyz012345"));
        assert!(line.contains("tatsu:***@github.com"));
    }

    /// 場所が取れなくても行にする（`panic_any` など）。
    #[test]
    fn a_panic_without_a_location_still_reads() {
        assert_eq!(panic_text("落ちた", None), "panic at 場所不明: 落ちた");
    }
}
