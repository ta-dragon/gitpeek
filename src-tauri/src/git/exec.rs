//! git サブプロセス実行の単一チョークポイント。
//!
//! **ここ以外で `Command::new("git")` を書いてはいけない。**
//! 固定オプション（docs/DESIGN.md §3.1）と固定環境変数（§3.2）の付与、およびコマンドログへの
//! 記録がここに集約されている。個別に git を起動すると、日本語パスの 8 進エスケープや
//! 認証時のハングといった不具合が静かに混入する。

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

use crate::commandlog::{CommandLogEntry, LogSink};

/// 全 git 呼び出しに固定付与する設定。
///
/// - `core.quotepath=false`  : 無いと日本語ファイル名が 8 進エスケープされて返る
/// - `core.autocrlf=false`   : ユーザーの .gitconfig に左右されない挙動を得る
/// - `core.pager=cat`        : pager 起動でハングするのを防ぐ
/// - `color.ui=false`        : ANSI エスケープの混入を防ぐ
/// - `core.commitGraph=false`: **本アプリの読み方では commit-graph が遅い**（下記）
///
/// # commit-graph を無効にする理由
///
/// commit-graph は「メッセージを読まずに履歴をたどる」操作を速くする仕組みだが、
/// Givsoner の主問い合わせは `%an`/`%ae`/`%s` を含む全件ダンプであり、**結局どのみち
/// コミットオブジェクトを 1 件ずつ読む**。commit-graph を有効にすると、そこへ
/// 89MB のグラフファイルへのアクセスが上乗せされるだけになる。
///
/// Linux カーネル（1,481,526 コミット / pack 6.6GB / 同一マシンで A-B 計測）:
///
/// | `core.commitGraph` | `git log --branches --remotes HEAD --topo-order -z --format=…` |
/// |---|---|
/// | `true` | 59.5 秒 |
/// | `false` | 19.0 秒 |
///
/// ahead/behind はメモリ上のグラフから計算する（docs/DESIGN.md §4.5）ので、
/// commit-graph が効く `rev-list --count` 系はそもそも呼ばない。
/// git は `gc` の際に commit-graph を自動生成するため、**明示的に切っておかないと
/// ある日突然 3 倍遅くなる**。
pub const FIXED_ARGS: &[&str] = &[
    "-c",
    "core.quotepath=false",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.pager=cat",
    "-c",
    "color.ui=false",
    "-c",
    "core.commitGraph=false",
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

    /// 非ゼロ終了を画面向けの 1 行にする。
    ///
    /// 生の stderr は全文がコマンドログに残っているので、ここでは先頭行だけを添える
    /// （docs/DESIGN.md §3.6「人間向けメッセージ ＋ 展開で生 stderr」）。
    pub fn failure(&self, context: &str) -> String {
        match self.stderr.lines().find(|line| !line.trim().is_empty()) {
            Some(line) => format!("{context}: {}", line.trim()),
            None => match self.exit_code {
                Some(code) => format!("{context}（終了コード {code}）"),
                None => context.to_string(),
            },
        }
    }
}

/// git を 1 回実行し、結果をコマンドログに記録して返す。
///
/// `Err` はプロセスの起動自体に失敗した場合（git が見つからない等）。
/// git が起動して非ゼロ終了した場合は `Ok` で返り、`GitOutput::ok()` が `false` になる。
pub fn run(
    log: &dyn LogSink,
    program: &str,
    repo: Option<&Path>,
    args: &[&str],
) -> Result<GitOutput, String> {
    let mut command = build(program, repo, args);

    let started = Instant::now();
    let result = command.output();
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let exit_code = output.status.code();
            record(log, program, repo, args, exit_code, &stderr, duration_ms);
            Ok(GitOutput {
                stdout: output.stdout,
                stderr,
                exit_code,
            })
        }
        Err(error) => {
            let message = error.to_string();
            record(log, program, repo, args, None, &message, duration_ms);
            Err(message)
        }
    }
}

/// stdout を読みながら `on_stdout` に渡しつつ実行する。
///
/// [`run`] と違い**完了を待たずに読み進める**ので、長い出力の途中経過を報告できる。
/// 全件ダンプは 100 万コミット級で 300MB・十数秒に達し、終わるまで何も言えないと
/// 「固まった」ようにしか見えないため（docs/DESIGN.md §4.6）。
///
/// 蓄積した stdout は [`run`] と同じく `GitOutput` に入って返る。
pub fn run_streaming(
    log: &dyn LogSink,
    program: &str,
    repo: Option<&Path>,
    args: &[&str],
    on_stdout: &mut dyn FnMut(&[u8]),
) -> Result<GitOutput, String> {
    let mut command = build(program, repo, args);
    let started = Instant::now();

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = error.to_string();
            let duration_ms = started.elapsed().as_millis() as u64;
            record(log, program, repo, args, None, &message, duration_ms);
            return Err(message);
        }
    };

    // stderr は**別スレッドで**吸い出す。stdout だけ読んでいると、stderr のパイプが
    // 埋まった時点で git 側が書き込みで止まり、双方待ち合わせて固まる。
    let mut stderr_pipe = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    });

    let mut stdout = Vec::new();
    let mut read_error = None;
    if let Some(pipe) = child.stdout.as_mut() {
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    stdout.extend_from_slice(&chunk[..read]);
                    on_stdout(&chunk[..read]);
                }
                Err(error) => {
                    read_error = Some(error.to_string());
                    break;
                }
            }
        }
    }

    let status = child.wait();
    let stderr = stderr_reader
        .join()
        .map(|buffer| String::from_utf8_lossy(&buffer).into_owned())
        .unwrap_or_default();
    let duration_ms = started.elapsed().as_millis() as u64;

    match (status, read_error) {
        (Ok(status), None) => {
            let exit_code = status.code();
            record(log, program, repo, args, exit_code, &stderr, duration_ms);
            Ok(GitOutput {
                stdout,
                stderr,
                exit_code,
            })
        }
        (status, read_error) => {
            let message = read_error.unwrap_or_else(|| match status {
                Ok(_) => String::new(),
                Err(error) => error.to_string(),
            });
            record(log, program, repo, args, None, &message, duration_ms);
            Err(message)
        }
    }
}

/// 固定オプションと固定環境変数を付けた `Command` を組み立てる。
///
/// **[`run`] と [`run_streaming`] の両方がここを通る。** 片方だけに付け足すと、
/// 経路によって挙動が変わる（日本語パスが化ける、認証で固まる）。
fn build(program: &str, repo: Option<&Path>, args: &[&str]) -> Command {
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

    command
}

fn record(
    log: &dyn LogSink,
    program: &str,
    repo: Option<&Path>,
    args: &[&str],
    exit_code: Option<i32>,
    stderr: &str,
    duration_ms: u64,
) {
    log.record(CommandLogEntry::new(
        program.to_string(),
        FIXED_ARGS.iter().map(|arg| (*arg).to_string()).collect(),
        repo.map(|path| path.display().to_string()),
        args.iter().map(|arg| (*arg).to_string()).collect(),
        exit_code,
        stderr.to_string(),
        duration_ms,
    ));
}
