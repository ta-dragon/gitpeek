//! ログの配線（T-24）。
//!
//! **`logging::format_line` を通ったものだけがファイルへ落ちる**ことを、
//! 実際に書いて読み直して確かめる。単体テスト（`src/logging.rs`）が見ているのは
//! 組み立てだけで、**`log` の口から書き出しまで繋がっているか**は見ていない。
//!
//! 本番の書き出しは `tauri-plugin-log` が持っているが、プラグインの登録には
//! Tauri アプリが要る。ここでは**同じ組み立て関数を使う記録先**を自分で立てて、
//! `commandlog.rs` が本当に `log` へ流していることと、
//! **平文の資格情報がファイルに残らない**ことを見る。

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use givsoner_lib::commandlog::{CommandLog, CommandLogEntry};
use givsoner_lib::logging::format_line;

/// 書き出し先。テストバイナリで 1 つだけ立てる（`log` の記録先は 1 つしか置けない）。
static SINK: OnceLock<PathBuf> = OnceLock::new();
static FILE: Mutex<Option<fs::File>> = Mutex::new(None);

struct TestLogger;

impl log::Log for TestLogger {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        // **本番と同じ組み立てを通す。** ここを別に書くと、確かめたい規則が
        // 二重になって意味を失う。
        let line = format_line(
            &chrono::Local::now(),
            record.level(),
            record.target(),
            &record.args().to_string(),
        );
        if let Some(file) = FILE.lock().expect("記録先").as_mut() {
            writeln!(file, "{line}").expect("書けること");
        }
    }

    fn flush(&self) {}
}

fn start() -> PathBuf {
    SINK.get_or_init(|| {
        // **テストの間だけ残るファイル。** `tempfile` の後始末に任せると
        // 記録先が先に消えるので、自分で場所を決めて置く。
        let path = std::env::temp_dir().join("givsoner-test-logging.log");
        let _ = fs::remove_file(&path);
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .expect("記録先を開けること");
        *FILE.lock().expect("記録先") = Some(file);
        log::set_boxed_logger(Box::new(TestLogger)).expect("記録先は 1 つだけ");
        log::set_max_level(log::LevelFilter::Info);
        path
    })
    .clone()
}

/// **git の実行がログファイルまで届き、そこに平文が残らない。**
///
/// `CommandLog::record` は画面用のリングバッファに積むだけでなく、
/// `log` へも 1 行流している。**その経路が繋がっていること**を、
/// 書いたファイルを読み直して確かめる（テストが緑でも動かない、を避ける）。
#[test]
fn a_git_command_reaches_the_file_without_plain_credentials() {
    let path = start();
    let secret = "ghp_abcdefghijklmnopqrstuvwxyz012345";

    let log = CommandLog::default();
    log.record(CommandLogEntry::new(
        "git".to_string(),
        vec!["-c".to_string(), "core.quotepath=false".to_string()],
        Some(r"C:\repo".to_string()),
        vec!["fetch".to_string(), "origin".to_string()],
        Some(128),
        format!("fatal: unable to access 'https://tatsu:{secret}@github.com/o/r.git'"),
        34,
    ));

    let written = fs::read_to_string(&path).expect("書いたものを読めること");
    assert!(
        written.contains("git exit=128 34ms"),
        "git の実行がログへ流れていない: {written}"
    );
    // **伏せ字になった形まで見る。** 「含まれない」だけだと、
    // そもそも書けていないときにも通ってしまう。
    assert!(
        written.contains("tatsu:***@github.com"),
        "伏せ字になっていない: {written}"
    );
    assert!(!written.contains(secret), "平文のトークンが残っている: {written}");
}

/// **同時に書いても行が壊れない。**
///
/// git の実行は並列に走る（レビューの並列度、一括 fetch）。混ざった行が出ると、
/// 後から追うときに読めなくなる。
#[test]
fn concurrent_writes_keep_whole_lines() {
    let path = start();
    let marker = "並行の目印";
    let threads = 8;
    let per_thread = 25;

    std::thread::scope(|scope| {
        for id in 0..threads {
            scope.spawn(move || {
                for n in 0..per_thread {
                    log::info!(target: "test", "{marker} {id}-{n}");
                }
            });
        }
    });

    let written = fs::read_to_string(&path).expect("書いたものを読めること");
    let lines: Vec<&str> = written
        .lines()
        .filter(|line| line.contains(marker))
        .collect();
    assert_eq!(lines.len(), threads * per_thread, "行が落ちている");
    // どの行も「時刻 → レベル → 種別 → 本文」の形のまま。
    for line in lines {
        assert!(line.contains("INFO"), "行が混ざっている: {line}");
        assert!(line.contains(" test "), "行が混ざっている: {line}");
    }
}
