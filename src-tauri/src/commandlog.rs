//! git コマンドログ。
//!
//! 実行した全 git コマンド・exit code・stderr・所要時間を保持し、画面に見せる。
//! 作者が git CLI 操作派である以上、「このアプリが裏で何を実行したか」が完全に見えることが
//! 信頼に直結する。詳細は docs/DESIGN.md §3.5。
//!
//! 保持は直近 500 件のリングバッファ。**リポジトリ切替でクリアしない。**

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::redact::redact;

/// リングバッファの容量。
pub const CAPACITY: usize = 500;

/// 新しいエントリが積まれたときにフロントへ送るイベント名。
pub const EVENT: &str = "command-log";

/// 1 回の git 実行の記録。
///
/// `fixed_args` は全呼び出しに固定付与される `-c ...` 群（docs/DESIGN.md §3.1）。
/// 画面では淡色で表示し、実際に何が付いているかを隠さない。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandLogEntry {
    pub id: u64,
    pub started_at: String,
    pub program: String,
    pub fixed_args: Vec<String>,
    pub repo: Option<String>,
    pub args: Vec<String>,
    pub exit_code: Option<i32>,
    pub stderr: String,
    pub duration_ms: u64,
    pub ok: bool,
}

impl CommandLogEntry {
    pub fn new(
        program: String,
        fixed_args: Vec<String>,
        repo: Option<String>,
        args: Vec<String>,
        exit_code: Option<i32>,
        stderr: String,
        duration_ms: u64,
    ) -> Self {
        Self {
            id: 0,
            started_at: chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            program,
            fixed_args,
            repo,
            args,
            exit_code,
            stderr,
            duration_ms,
            ok: exit_code == Some(0),
        }
    }

    /// 秘匿情報をマスクする。`CommandLog::push` の内部でのみ呼ぶ。
    fn redacted(mut self) -> Self {
        self.program = redact(&self.program);
        self.repo = self.repo.as_deref().map(redact);
        self.args = self.args.iter().map(|arg| redact(arg)).collect();
        self.stderr = redact(&self.stderr);
        self
    }
}

#[derive(Default)]
pub struct CommandLog {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    entries: VecDeque<CommandLogEntry>,
}

impl CommandLog {
    /// エントリを積み、マスキングと ID 採番を済ませた実体を返す。
    /// マスキングはここでしか行わないので、呼び出し側は何もしなくてよい。
    pub fn record(&self, entry: CommandLogEntry) -> CommandLogEntry {
        let mut inner = self.inner.lock().expect("command log poisoned");
        inner.next_id += 1;
        let mut entry = entry.redacted();
        entry.id = inner.next_id;
        if inner.entries.len() >= CAPACITY {
            inner.entries.pop_front();
        }
        inner.entries.push_back(entry.clone());
        drop(inner);

        // **ログファイルにも同じ 1 件を残す**（T-24）。画面のリングバッファは
        // 500 件で流れていくので、後から追うには足りない。
        if entry.ok {
            log::info!(target: "git", "{}", log_line(&entry));
        } else {
            log::warn!(target: "git", "{}", log_line(&entry));
        }
        entry
    }

    pub fn entries(&self) -> Vec<CommandLogEntry> {
        self.inner
            .lock()
            .expect("command log poisoned")
            .entries
            .iter()
            .cloned()
            .collect()
    }
}

/// ログファイルへ書く 1 件（T-24）。
///
/// **stderr は全文残す**（利用者の判断。2026-09-06）。認証まわりの問題は再現が難しく、
/// 1 行目だけでは足りないことが多い。**固定オプションは載せない** —
/// 全呼び出しで同じなので、毎行に並べても読みづらくなるだけ（画面には出ている）。
///
/// マスキングは [`CommandLog::record`] で済んでいるが、書き出しの口
/// （`logging::format_line`）でももう一度通る。
pub fn log_line(entry: &CommandLogEntry) -> String {
    let exit = match entry.exit_code {
        Some(code) => code.to_string(),
        None => "起動失敗".to_string(),
    };
    let repo = entry.repo.as_deref().unwrap_or("-");
    let head = format!(
        "{} exit={exit} {}ms [{repo}] {}",
        entry.program,
        entry.duration_ms,
        entry.args.join(" ")
    );
    let stderr = entry.stderr.trim_end();
    if stderr.is_empty() {
        head
    } else {
        format!("{head}\n{stderr}")
    }
}

/// git 実行の記録先。
///
/// `git/exec.rs` を Tauri から切り離すための境界。本番は [`EmittingLog`]（ログに積んだうえで
/// フロントへイベントを送る）、テストは [`CommandLog`] をそのまま渡す（積むだけ）。
pub trait LogSink {
    fn record(&self, entry: CommandLogEntry);
}

impl LogSink for CommandLog {
    fn record(&self, entry: CommandLogEntry) {
        CommandLog::record(self, entry);
    }
}

/// ログに積み、`command-log` イベントでフロントへも送る記録先。
pub struct EmittingLog<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    log: &'a CommandLog,
}

impl<'a, R: Runtime> EmittingLog<'a, R> {
    pub fn new(app: &'a AppHandle<R>, log: &'a CommandLog) -> Self {
        Self { app, log }
    }
}

impl<R: Runtime> LogSink for EmittingLog<'_, R> {
    fn record(&self, entry: CommandLogEntry) {
        let stored = self.log.record(entry);
        let _ = self.app.emit(EVENT, stored);
    }
}

#[cfg(test)]
mod tests {
    use super::{log_line, CommandLog, CommandLogEntry};

    fn entry(exit_code: Option<i32>, stderr: &str) -> CommandLogEntry {
        CommandLogEntry::new(
            "git".to_string(),
            vec!["-c".to_string(), "core.quotepath=false".to_string()],
            Some(r"C:\repo".to_string()),
            vec!["fetch".to_string(), "origin".to_string()],
            exit_code,
            stderr.to_string(),
            34,
        )
    }

    #[test]
    fn writes_the_command_and_how_it_ended() {
        let line = log_line(&entry(Some(0), ""));
        assert!(line.starts_with(r"git exit=0 34ms [C:\repo] fetch origin"));
        // **固定オプションは載せない**（全呼び出しで同じ）。
        assert!(!line.contains("core.quotepath"));
    }

    /// **stderr は全文残す**（利用者の判断。2026-09-06）。
    #[test]
    fn keeps_the_whole_stderr() {
        let line = log_line(&entry(Some(128), "1 行目\n2 行目\n"));
        assert!(line.contains("exit=128"));
        assert!(line.contains("1 行目\n2 行目"));
        // 末尾の空行は落とす（字下げした空行が残ると読みにくい）。
        assert!(!line.ends_with('\n'));
    }

    /// 起動すらできなかったときは exit code が無い。**「0」と書かない。**
    #[test]
    fn a_command_that_never_started_says_so() {
        assert!(log_line(&entry(None, "")).contains("exit=起動失敗"));
    }

    /// 積むときにマスクされる（画面もログも同じ 1 件を見る）。
    #[test]
    fn masks_credentials_before_anything_else_sees_them() {
        let log = CommandLog::default();
        let stored = log.record(entry(
            Some(128),
            "fatal: https://tatsu:ghp_abcdefghijklmnopqrstuvwxyz012345@github.com/o/r.git",
        ));
        assert!(!stored.stderr.contains("ghp_abcdefghijklmnopqrstuvwxyz012345"));
        assert!(!log_line(&stored).contains("ghp_abcdefghijklmnopqrstuvwxyz012345"));
    }
}
