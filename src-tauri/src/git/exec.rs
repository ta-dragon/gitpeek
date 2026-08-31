//! git サブプロセス実行の単一チョークポイント。
//!
//! **ここ以外で `Command::new("git")` を書いてはいけない。**
//! 固定オプション（docs/DESIGN.md §3.1）と固定環境変数（§3.2）の付与、およびコマンドログへの
//! 記録がここに集約されている。個別に git を起動すると、日本語パスの 8 進エスケープや
//! 認証時のハングといった不具合が静かに混入する。

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

use tauri::AppHandle;

use crate::commandlog::{CommandLog, CommandLogEntry};

/// 全 git 呼び出しに固定付与する設定。
///
/// - `core.quotepath=false` : 無いと日本語ファイル名が 8 進エスケープされて返る
/// - `core.autocrlf=false`  : ユーザーの .gitconfig に左右されない挙動を得る
/// - `core.pager=cat`       : pager 起動でハングするのを防ぐ
/// - `color.ui=false`       : ANSI エスケープの混入を防ぐ
pub const FIXED_ARGS: &[&str] = &[
    "-c",
    "core.quotepath=false",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.pager=cat",
    "-c",
    "color.ui=false",
];

/// GUI アプリからサブプロセスを起動したときにコンソールウィンドウを出さない。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// git の実行結果。所要時間はコマンドログ側に記録されるのでここには持たない。
pub struct GitOutput {
    /// 生バイト列のまま保持する。文字コード判別は呼び出し側の責務（docs/DESIGN.md §9.1）。
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

impl GitOutput {
    pub fn ok(&self) -> bool {
        self.exit_code == Some(0)
    }

    /// UTF-8 として読める前提の出力（`--version` など）専用。
    /// リポジトリ内のファイル名や内容には使わないこと。
    pub fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// git を 1 回実行し、結果をコマンドログに記録して返す。
///
/// `Err` はプロセスの起動自体に失敗した場合（git が見つからない等）。
/// git が起動して非ゼロ終了した場合は `Ok` で返り、`GitOutput::ok()` が `false` になる。
pub fn run(
    app: &AppHandle,
    log: &CommandLog,
    program: &str,
    repo: Option<&Path>,
    args: &[&str],
) -> Result<GitOutput, String> {
    let mut command = Command::new(program);
    command.args(FIXED_ARGS);
    if let Some(repo) = repo {
        command.arg("-C").arg(repo);
    }
    command.args(args);

    // 認証が必要な場面で端末入力を待ってハングするのを防ぐ（docs/DESIGN.md §3.2）。
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let started = Instant::now();
    let result = command.output();
    let duration_ms = started.elapsed().as_millis() as u64;

    let make_entry = |exit_code: Option<i32>, stderr: String| {
        CommandLogEntry::new(
            program.to_string(),
            FIXED_ARGS.iter().map(|arg| (*arg).to_string()).collect(),
            repo.map(|path| path.display().to_string()),
            args.iter().map(|arg| (*arg).to_string()).collect(),
            exit_code,
            stderr,
            duration_ms,
        )
    };

    match result {
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let exit_code = output.status.code();
            log.push(app, make_entry(exit_code, stderr.clone()));
            Ok(GitOutput {
                stdout: output.stdout,
                stderr,
                exit_code,
            })
        }
        Err(error) => {
            let message = error.to_string();
            log.push(app, make_entry(None, message.clone()));
            Err(message)
        }
    }
}
