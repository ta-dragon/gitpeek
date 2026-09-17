//! git サブプロセス実行の単一チョークポイント。
//!
//! **ここ以外で `Command::new("git")` を書いてはいけない。**
//! 固定オプション（docs/DESIGN.md §3.1）と固定環境変数（§3.2）の付与、およびコマンドログへの
//! 記録がここに集約されている。個別に git を起動すると、日本語パスの 8 進エスケープや
//! 認証時のハングといった不具合が静かに混入する。

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::commandlog::{CommandLogEntry, LogSink};
use crate::redact::redact;

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
/// GitPeek の主問い合わせは `%an`/`%ae`/`%s` を含む全件ダンプであり、**結局どのみち
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
    /// **`redact` を通してある**（T-24 の点検。CLAUDE.md §4）。
    ///
    /// stderr は画面にもログにも出る唯一の経路なので、**組み立てるここで 1 度だけ**
    /// マスクする。呼び出し側が忘れても平文が漏れない
    /// （個別に通していた `git/ops.rs` はそのままでよい — 二重に通っても変わらない）。
    /// マスクが書き換えるのは資格情報らしき部分だけなので、`fatal:` などの
    /// 目印を見るパースには影響しない。
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
    run_with_env(log, program, repo, args, &[])
}

/// [`run`] に、**その実行だけの環境変数**を足したもの（T-37）。
///
/// 使うのは `git merge-tree --write-tree` だけで、**書き込み先をリポジトリの外の一時フォルダへ
/// 逸らす**ため（`GIT_OBJECT_DIRECTORY` / `GIT_ALTERNATE_OBJECT_DIRECTORIES`。docs/DESIGN.md §7.6、
/// CLAUDE.md §1 の 4 件目）。**固定の環境変数は上書きできない**（[`build`] が後から付ける）。
pub fn run_with_env(
    log: &dyn LogSink,
    program: &str,
    repo: Option<&Path>,
    args: &[&str],
    env: &[(&str, &std::ffi::OsStr)],
) -> Result<GitOutput, String> {
    let mut command = build(program, repo, args, env);

    let started = Instant::now();
    let result = command.output();
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(output) => {
            let stderr = redact(&String::from_utf8_lossy(&output.stderr));
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

/// stdout を読みながら `on_stdout` に渡しつつ実行する。**中止の旗も渡せる。**
///
/// [`run`] と違い**完了を待たずに読み進める**ので、長い出力の途中経過を報告できる。
/// 全件ダンプは 100 万コミット級で 300MB・十数秒に達し、終わるまで何も言えないと
/// 「固まった」ようにしか見えないため（docs/DESIGN.md §4.6）。
///
/// `cancel` を渡すと、**旗を見張る別スレッドから子プロセスを落とす**（[`run_progress`] と
/// 同じ作り）。コード内容の検索（`log -S`）は**当たるまで何も出さない**ので、読み取りの
/// 合間の判定だけでは止まらない（T-36。docs/DESIGN.md §6.6）。中止したかどうかは
/// 呼び出し側が旗で見ること — 落とされた git は非ゼロで終わるので、成否を先に見ると
/// **利用者自身の中止を「失敗」と報告してしまう。**
///
/// 蓄積した stdout は [`run`] と同じく `GitOutput` に入って返る（中止したときは途中まで）。
pub fn run_streaming(
    log: &dyn LogSink,
    program: &str,
    repo: Option<&Path>,
    args: &[&str],
    cancel: Option<&Cancel>,
    on_stdout: &mut dyn FnMut(&[u8]),
) -> Result<GitOutput, String> {
    let mut command = build(program, repo, args, &[]);
    let started = Instant::now();

    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = error.to_string();
            let duration_ms = started.elapsed().as_millis() as u64;
            record(log, program, repo, args, None, &message, duration_ms);
            return Err(message);
        }
    };

    let child = Arc::new(Mutex::new(child));

    // パイプを先に取り出す。ここだけ短く lock する（見張りと奪い合わないように）。
    let (stdout_pipe, mut stderr_pipe) = {
        let mut guard = child.lock().expect("子プロセスの lock");
        (guard.stdout.take(), guard.stderr.take())
    };

    // stderr は**別スレッドで**吸い出す。stdout だけ読んでいると、stderr のパイプが
    // 埋まった時点で git 側が書き込みで止まり、双方待ち合わせて固まる。
    let stderr_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    });

    // 中止の見張り。**旗を渡されたときだけ**立てる（全件ダンプは中止しない）。
    let finished = Arc::new(AtomicBool::new(false));
    let watchdog = cancel.map(|cancel| {
        let child = Arc::clone(&child);
        let finished = Arc::clone(&finished);
        let cancel = cancel.clone();
        std::thread::spawn(move || {
            while !finished.load(Ordering::SeqCst) {
                if cancel.is_cancelled() {
                    if let Ok(mut guard) = child.lock() {
                        let _ = guard.kill();
                    }
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        })
    });
    let cancelled = || cancel.is_some_and(Cancel::is_cancelled);

    let mut stdout = Vec::new();
    let mut read_error = None;
    if let Some(mut pipe) = stdout_pipe {
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    stdout.extend_from_slice(&chunk[..read]);
                    on_stdout(&chunk[..read]);
                    if cancelled() {
                        break;
                    }
                }
                Err(error) => {
                    // 見張りに落とされるとパイプが切れて読み取りが失敗することがある。
                    // **中止した結果であって、読み取りの失敗ではない。**
                    if !cancelled() {
                        read_error = Some(error.to_string());
                    }
                    break;
                }
            }
        }
    }

    // **`wait()` より先に見張りを畳む。** `wait()` は lock を握ったまま子の終了を待つので、
    // その間に見張りが lock を取りに来ると、二者が待ち合って固まる。
    if cancelled() {
        if let Ok(mut guard) = child.lock() {
            let _ = guard.kill();
        }
    }
    finished.store(true, Ordering::SeqCst);
    if let Some(watchdog) = watchdog {
        let _ = watchdog.join();
    }

    let status = child.lock().expect("子プロセスの lock").wait();
    let stderr = stderr_reader
        .join()
        .map(|buffer| redact(&String::from_utf8_lossy(&buffer)))
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

/// 中止の合図。長い実行を外から止めるために渡す。
///
/// クローンしても同じ旗を指す。**中止しても、既に更新された ref は戻らない**ので、
/// 呼び出し側は「途中まで進んでいる」ことを結果に書くこと（docs/DESIGN.md §8.3）。
#[derive(Debug, Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// 同じ旗を指しているか。**終わった実行が、後から始まった実行の旗を片付けない**ために使う。
    pub fn is_same(&self, other: &Cancel) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

/// **stderr** を読みながら `on_stderr` に渡しつつ実行する。中止もできる。
///
/// [`run_streaming`] と読む向きが逆なのは、**git の進捗が stderr に出る**ため
/// （`fetch --progress` / `clone --progress`）。[`run_streaming`] は stderr を別スレッドで
/// 最後まで読み切ってから返すので、そのままでは進捗が全部終わってから 1 度に届く。
///
/// stdout はここでは別スレッドで読み切る。fetch の stdout は空なので量は問題にならないが、
/// **読まずに放置するとパイプが埋まって git 側が止まる**ので必ず吸い出す。
///
/// 中止は 2 段構えにしてある。読み取りは呼び出し元スレッドを塞ぐので、
/// **旗を見張る別スレッドから子プロセスを落とす**。fetch は進捗を出し続けるので
/// 実際には読み取りの合間の判定でだいたい間に合うが、認証待ちのように**何も出ない
/// まま止まる**場面があるため、見張りの方が本命になる。
///
/// なお、落とせるのは**起動した git 本体だけ**で、その子（`git-remote-https` など）は
/// 残りうる。親が死ねば追って終わるが、即座ではない。
pub fn run_progress(
    log: &dyn LogSink,
    program: &str,
    repo: Option<&Path>,
    args: &[&str],
    cancel: &Cancel,
    on_stderr: &mut dyn FnMut(&[u8]),
) -> Result<GitOutput, String> {
    let mut command = build(program, repo, args, &[]);
    let started = Instant::now();

    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = error.to_string();
            let duration_ms = started.elapsed().as_millis() as u64;
            record(log, program, repo, args, None, &message, duration_ms);
            return Err(message);
        }
    };

    let child = Arc::new(Mutex::new(child));

    // パイプを先に取り出す。ここだけ短く lock する（見張りと奪い合わないように）。
    let (mut stderr_pipe, stdout_pipe) = {
        let mut guard = child.lock().expect("子プロセスの lock");
        (guard.stderr.take(), guard.stdout.take())
    };

    // stdout は読み捨てず吸い出す。放置するとパイプが埋まって git が書き込みで止まる。
    let stdout_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(mut pipe) = stdout_pipe {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    });

    // 中止の見張り。読み取りが塞がっていても子を落とせる唯一の経路。
    let finished = Arc::new(AtomicBool::new(false));
    let watchdog = {
        let child = Arc::clone(&child);
        let finished = Arc::clone(&finished);
        let cancel = cancel.clone();
        std::thread::spawn(move || {
            while !finished.load(Ordering::SeqCst) {
                if cancel.is_cancelled() {
                    if let Ok(mut guard) = child.lock() {
                        let _ = guard.kill();
                    }
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        })
    };

    let mut stderr_bytes = Vec::new();
    let mut read_error = None;
    if let Some(pipe) = stderr_pipe.as_mut() {
        let mut chunk = vec![0u8; 16 * 1024];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    stderr_bytes.extend_from_slice(&chunk[..read]);
                    on_stderr(&chunk[..read]);
                    if cancel.is_cancelled() {
                        break;
                    }
                }
                Err(error) => {
                    read_error = Some(error.to_string());
                    break;
                }
            }
        }
    }

    // **`wait()` より先に見張りを畳む。** `wait()` は lock を握ったまま子の終了を待つので、
    // その間に見張りが lock を取りに来ると、二者が待ち合って固まる。
    if cancel.is_cancelled() {
        if let Ok(mut guard) = child.lock() {
            let _ = guard.kill();
        }
    }
    finished.store(true, Ordering::SeqCst);
    let _ = watchdog.join();

    let status = child.lock().expect("子プロセスの lock").wait();
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = redact(&String::from_utf8_lossy(&stderr_bytes));
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
/// **[`run`]（[`run_with_env`]）/ [`run_streaming`] / [`run_progress`] のすべてがここを通る。** 一部だけに
/// 付け足すと、経路によって挙動が変わる（日本語パスが化ける、認証で固まる）。
fn build(
    program: &str,
    repo: Option<&Path>,
    args: &[&str],
    env: &[(&str, &std::ffi::OsStr)],
) -> Command {
    let mut command = Command::new(program);
    command.args(FIXED_ARGS);
    if let Some(repo) = repo {
        command.arg("-C").arg(repo);
    }
    command.args(args);

    // 呼び出しごとの環境変数は**固定のものより先に**付ける。同じ名前なら固定のほうが勝つ。
    for (name, value) in env {
        command.env(name, value);
    }

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
