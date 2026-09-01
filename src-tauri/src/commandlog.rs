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
