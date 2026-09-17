//! `git/exec.rs` の入口そのものの結合テスト（T-36 / T-37 で足した口）。
//!
//! 入口ごとの使われ方（検索・取り込み判定・fetch・clone）はそれぞれのテストが見ている。
//! ここで見るのは、**入口が約束していることそのもの**。

use std::ffi::OsStr;

use gitpeek_lib::commandlog::CommandLog;
use gitpeek_lib::git::exec::{self, Cancel};

/// git の alias から `printenv` を呼び、**git に実際に届いた環境変数**を読む。
/// Git for Windows には `printenv` が付いている。
fn printed_env(env: &[(&str, &OsStr)]) -> String {
    let output = exec::run_with_env(
        &CommandLog::default(),
        "git",
        None,
        &[
            "-c",
            "alias.envprobe=!printenv GIT_TERMINAL_PROMPT GITPEEK_PROBE",
            "envprobe",
        ],
        env,
    )
    .expect("git を起動できること");
    assert!(output.ok(), "printenv が失敗した: {}", output.stderr);
    output.stdout_lossy()
}

#[test]
fn extra_environment_variables_reach_git() {
    // merge-tree の書き込み先を逸らす環境変数は、この口からしか渡せない（T-37）。
    let printed = printed_env(&[("GITPEEK_PROBE", OsStr::new("delivered"))]);
    assert!(printed.lines().any(|line| line == "delivered"), "{printed}");
}

#[test]
fn fixed_environment_variables_cannot_be_overridden() {
    // **`GIT_TERMINAL_PROMPT=0` が外れると、認証が要る場面で端末入力を待って固まる**
    // （docs/DESIGN.md §3.2）。呼び出しごとの環境変数で上書きできてはいけない。
    let printed = printed_env(&[
        ("GIT_TERMINAL_PROMPT", OsStr::new("1")),
        ("GITPEEK_PROBE", OsStr::new("delivered")),
    ]);
    let lines: Vec<&str> = printed.lines().collect();
    assert_eq!(lines.first(), Some(&"0"), "固定の環境変数が上書きされた: {printed}");
}

#[test]
fn a_cancel_flag_is_the_same_only_as_its_own_clones() {
    // 検索の中止枠は「終わった検索が、自分の合図のときだけ空ける」（T-36）。
    // 取り違えると、後から始めた検索の中止ボタンが効かなくなる。
    let first = Cancel::new();
    let clone = first.clone();
    let second = Cancel::new();
    assert!(first.is_same(&clone));
    assert!(!first.is_same(&second));

    // 同じ旗なので、片方で止めればもう片方も止まっている。
    clone.cancel();
    assert!(first.is_cancelled());
    assert!(!second.is_cancelled());
}
