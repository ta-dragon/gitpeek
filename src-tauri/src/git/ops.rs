//! 書き込み系の git 操作（docs/DESIGN.md §8）。
//!
//! **git に対して書き込むのは checkout / fetch / merge --ff-only / clone の 4 つだけ**
//! （CLAUDE.md §1）。このモジュールに他の操作を足さないこと。v1 で入っているのは
//! fetch だけで、残りは T-18 / T-19 で足す。

use std::path::Path;

use serde::Serialize;

use crate::commandlog::LogSink;
use crate::git::exec::{self, Cancel};
use crate::git::fetchprogress::{parse, FetchProgress, LineSplitter};
use crate::redact::redact;

/// `fetch` の固定引数（docs/DESIGN.md §8.3）。
///
/// - ここでの `--all` は「**全リモート**」の意味で、`git log --all`（CLAUDE.md §2 で
///   禁じている方）とは別物
/// - **`--prune-tags` を足さないこと。** `--prune --tags` はタグを消さない。足すと
///   ローカルにしか無いタグが消え、**ref の削除**になる（CLAUDE.md §1 違反）
/// - **`--progress` は必須。** stderr が端末でないと git は進捗を出さないので、
///   外すとバーが一度も動かない
/// - `--depth` / `--recurse-submodules` / `--force` は付けない（CLAUDE.md §1）
pub const FETCH_ARGS: &[&str] = &["fetch", "--all", "--prune", "--tags", "--progress"];

/// 進捗として読めなかった行を、結果の本文として何行まで残すか。
/// 認証エラーの説明は数行なので、これで足りないことはまず無い。
const MAX_LINES: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FetchStatus {
    Success,
    /// 一部だけ取り込めた。**いまのところタグの衝突だけ**（`clobbered_tags`）。
    ///
    /// 失敗と分けているのは、ブランチは取り込めているのに「失敗しました」と出ると、
    /// 直しようがないのに壊れたように見えるため。
    Partial,
    Failed,
    /// 利用者が止めた。**途中まで取り込まれている**ことに注意（下記）。
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchOutcome {
    pub status: FetchStatus,
    /// 画面に出す 1 行。失敗の理由はここで人間向けに言い換える。
    pub message: String,
    /// 進捗ではなかった stderr の行（`From …` / `* [new branch] …` / エラー）。
    /// **`redact.rs` を通してある**（CLAUDE.md §4）。
    pub lines: Vec<String>,
    pub duration_ms: u64,
}

/// リモートから取ってくる。**取ってくるだけで、作業ツリーには触らない。**
///
/// 中止は `cancel` を立てる。**中止しても、そこまでに更新された ref は戻らない。**
/// git は 1 つの ref を書き終えるたびに確定させていくので、途中で止めても
/// 「何も起きなかった」ことにはできない。結果の文言でそう伝える。
pub fn fetch(
    log: &dyn LogSink,
    program: &str,
    repo: &Path,
    cancel: &Cancel,
    on_progress: &mut dyn FnMut(FetchProgress),
) -> Result<FetchOutcome, String> {
    let mut splitter = LineSplitter::new();
    let mut lines: Vec<String> = Vec::new();

    let mut take = |line: String| {
        // **本文が上限に達していても進捗は流し続ける。** バーが途中で止まる。
        if lines.len() >= MAX_LINES {
            if let Some(progress) = parse(&line) {
                on_progress(progress);
            }
            return;
        }
        match classify(&line) {
            Line::Progress(progress) => on_progress(progress),
            Line::Body(body) => lines.push(body),
        }
    };

    let started = std::time::Instant::now();
    let output = exec::run_progress(log, program, Some(repo), FETCH_ARGS, cancel, &mut |chunk| {
        for line in splitter.push(chunk) {
            take(line);
        }
    })?;
    if let Some(line) = splitter.flush() {
        take(line);
    }

    let duration_ms = started.elapsed().as_millis() as u64;
    lines.retain(|line| !line.is_empty());

    // **中止の判定を成否より先に見る。** 中止すると git は非ゼロで落ちるので、
    // 順番を逆にすると利用者自身の操作を「失敗しました」と報告することになる。
    if cancel.is_cancelled() {
        return Ok(FetchOutcome {
            status: FetchStatus::Cancelled,
            message: "fetch を中止しました。そこまでに取り込まれた分は残っています。".to_string(),
            lines,
            duration_ms,
        });
    }

    if output.ok() {
        return Ok(FetchOutcome {
            status: FetchStatus::Success,
            message: summarize(&lines),
            lines,
            duration_ms,
        });
    }

    // 上流がタグを付け替えただけなら、ブランチは取り込めている。
    // **「失敗」と言わない** — 直しようがないのに壊れたように見える。
    let tags = clobbered_tags(&lines);
    if !tags.is_empty() && !output.stderr.contains("fatal:") {
        return Ok(FetchOutcome {
            status: FetchStatus::Partial,
            message: explain_clobbered_tags(&tags),
            lines,
            duration_ms,
        });
    }

    Ok(FetchOutcome {
        status: FetchStatus::Failed,
        message: explain(&output.stderr),
        lines,
        duration_ms,
    })
}

/// 上書きを拒まれたタグ名。
///
/// git はこう出す（先頭の `!` は `redact` 前の `trim` で残る）:
///
/// ```text
/// ! [rejected]        v4.6.6     -> v4.6.6  (would clobber existing tag)
/// ```
///
/// **上流はタグを付け替えることがある。** 同じ名前が手元と上流で別のコミットを指すと、
/// git は `--force` なしでは上書きしない。Givsoner はタグを書き換えないので
/// （CLAUDE.md §1）、**何が起きたかと、自分で直す方法**までを伝える。
fn clobbered_tags(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .filter(|line| line.contains("would clobber existing tag"))
        .filter_map(|line| rejected_name(line))
        .collect()
}

/// `… -> <名前>  (…)` の `<名前>`。
fn rejected_name(line: &str) -> Option<String> {
    let (_, right) = line.split_once("->")?;
    let name = right.split_whitespace().next()?;
    (!name.is_empty()).then(|| name.to_string())
}

/// タグが弾かれたときの説明。**自分で直せる形にする。**
fn explain_clobbered_tags(tags: &[String]) -> String {
    // 名前は 3 つまで。20 件あるときに全部並べても読めない。
    let shown = tags
        .iter()
        .take(3)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    let rest = tags.len().saturating_sub(3);
    let names = if rest > 0 {
        format!("{shown} ほか {rest} 件")
    } else {
        shown
    };

    format!(
        "タグ {} 件を更新できませんでした（{names}）。上流が同じ名前のタグを別のコミットへ付け替えています。Givsoner はタグを書き換えないので、手元を上流に合わせるならターミナルで `git fetch --tags --force` を実行してください（同じ名前のタグを手元で付け直していた場合は、そちらが上書きされます）。",
        tags.len(),
    )
}

/// stderr の 1 行の振り分け。
#[derive(Debug, PartialEq)]
enum Line {
    Progress(FetchProgress),
    /// 進捗でない行（`From …` / `* [new branch] …` / エラー）。
    Body(String),
}

/// 1 行を進捗か本文かに振り分ける。
///
/// **本文は必ず `redact.rs` を通してから返す**（CLAUDE.md §4）。
/// `https://<user>:<token>@…` 形式のリモートは fetch の stderr に平文で出ることがあり、
/// ここが画面とコマンドログの両方への入口になっている。
fn classify(line: &str) -> Line {
    match parse(line) {
        Some(progress) => Line::Progress(progress),
        None => Line::Body(redact(line.trim())),
    }
}

/// 成功したときの 1 行。何も来ていなければそう言う。
///
/// **「更新なし」を「成功」と区別する。** 毎回同じ「完了しました」だと、
/// 実際に何か降ってきたのかどうかが分からない。
fn summarize(lines: &[String]) -> String {
    let updated = lines
        .iter()
        .filter(|line| line.starts_with('*') || line.starts_with('+') || line.starts_with('-'))
        .count();
    if updated == 0 {
        "fetch しました（更新はありません）。".to_string()
    } else {
        format!("fetch しました（{updated} 件の ref を更新）。")
    }
}

/// 失敗の stderr を画面向けの 1 行にする（docs/DESIGN.md §3.6）。
///
/// **生の stderr は `lines` に残っている**ので、ここでは何をすればいいかだけを言う。
/// 認証まわりが分かりにくいのは、`exec.rs` が `GIT_TERMINAL_PROMPT=0` と
/// `BatchMode=yes` を付けている（＝無言でハングしない代わりに、その場で落ちる）ため。
fn explain(stderr: &str) -> String {
    const AUTH: &[&str] = &[
        "could not read Username",
        "could not read Password",
        "terminal prompts disabled",
        "Authentication failed",
    ];

    if AUTH.iter().any(|needle| stderr.contains(needle)) {
        return "認証できませんでした。ターミナルで一度 `git fetch` を実行して資格情報を登録してください。".to_string();
    }
    if stderr.contains("Permission denied (publickey)") {
        return "SSH の公開鍵で認証できませんでした。鍵が登録されているか確認してください（パスフレーズ付きの鍵は、先に ssh-agent へ登録しておく必要があります）。".to_string();
    }
    if stderr.contains("Host key verification failed") {
        return "SSH のホスト鍵が未登録です。ターミナルで一度接続して、既知のホストに登録してください。".to_string();
    }
    if stderr.contains("Could not resolve host") || stderr.contains("Could not resolve hostname") {
        return "リモートに接続できません（ホスト名を解決できませんでした）。".to_string();
    }
    if stderr.contains("does not appear to be a git repository") {
        return "リモートが git リポジトリとして応答しませんでした。URL を確認してください。"
            .to_string();
    }

    let first = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("remote:"));
    match first {
        Some(line) => format!("fetch に失敗しました: {}", redact(line)),
        None => "fetch に失敗しました。".to_string(),
    }
}

/// 最後の fetch から日数が経ちすぎているか（docs/DESIGN.md §8.3）。
///
/// - **リモートが 1 つも無いなら警告しない。** fetch しても `FETCH_HEAD` はできないので、
///   警告を出すとローカルだけのリポジトリで永久に出続ける
/// - **閾値 0 は無効**（設定で切れる）
/// - `last_fetch_at_ms` が `None` は「一度も fetch していない」。リモートがあるなら警告する
pub fn is_stale(
    has_remotes: bool,
    last_fetch_at_ms: Option<i64>,
    now_ms: i64,
    threshold_days: u32,
) -> bool {
    if !has_remotes || threshold_days == 0 {
        return false;
    }
    let Some(last) = last_fetch_at_ms else {
        return true;
    };
    let threshold_ms = i64::from(threshold_days) * 24 * 60 * 60 * 1000;
    // 未来の時刻（時計のずれ、OneDrive の同期）は「古い」と扱わない。
    now_ms.saturating_sub(last) > threshold_ms
}

#[cfg(test)]
mod tests {
    use super::{classify, clobbered_tags, explain, explain_clobbered_tags, is_stale, Line, FETCH_ARGS};

    const DAY: i64 = 24 * 60 * 60 * 1000;

    /// **CLAUDE.md §1 の禁止事項が引数に紛れ込んでいないこと。**
    #[test]
    fn fetch_args_stay_within_what_we_allow() {
        assert_eq!(
            FETCH_ARGS,
            &["fetch", "--all", "--prune", "--tags", "--progress"],
        );
        for banned in ["--prune-tags", "--depth", "--recurse-submodules", "--force"] {
            assert!(!FETCH_ARGS.contains(&banned), "{banned} を付けてはいけない");
        }
    }

    /// **タグの衝突を拾えること。** これを落とすと、ブランチが取り込めているのに
    /// 「失敗しました」としか出ず、利用者にはどうしようもなくなる。
    #[test]
    fn picks_up_tags_that_could_not_be_updated() {
        let lines = vec![
            "From https://example.com/foo/bar".to_string(),
            "! [rejected]        v4.6.6     -> v4.6.6  (would clobber existing tag)".to_string(),
            "! [rejected]        v4.6.7     -> v4.6.7  (would clobber existing tag)".to_string(),
            "* [new branch]      release    -> origin/release".to_string(),
        ];
        assert_eq!(clobbered_tags(&lines), vec!["v4.6.6", "v4.6.7"]);
    }

    /// 似て非なる拒否（非 fast-forward）を混ぜないこと。
    #[test]
    fn ignores_rejections_that_are_not_tag_clobbers() {
        let lines = vec![
            "! [rejected]        main       -> main  (non-fast-forward)".to_string(),
            "error: some local refs could not be updated".to_string(),
        ];
        assert!(clobbered_tags(&lines).is_empty());
    }

    /// **自分で直す方法まで書く。** 「失敗しました」だけでは手が無い。
    #[test]
    fn the_tag_message_says_what_to_run() {
        let tags: Vec<String> = (1..=5).map(|n| format!("v4.6.{n}")).collect();
        let message = explain_clobbered_tags(&tags);

        assert!(message.contains("5 件"), "{message}");
        assert!(message.contains("v4.6.1, v4.6.2, v4.6.3"), "{message}");
        assert!(message.contains("ほか 2 件"), "並べ切らずに畳むこと: {message}");
        assert!(message.contains("git fetch --tags --force"), "{message}");
    }

    /// 3 件以下なら「ほか」を付けない。
    #[test]
    fn the_tag_message_does_not_pad_a_short_list() {
        let message = explain_clobbered_tags(&["v1".to_string()]);
        assert!(message.contains("（v1）"), "{message}");
        assert!(!message.contains("ほか"), "{message}");
    }

    /// **本文は必ず伏せてから返す**（CLAUDE.md §4）。ここが画面とログへの入口。
    #[test]
    fn body_lines_are_redacted() {
        let line = "fatal: unable to access 'https://someone:s3cr3t@example.com/x.git/'";
        let Line::Body(body) = classify(line) else {
            panic!("進捗ではない行のはず");
        };
        assert!(!body.contains("s3cr3t"), "{body}");
        assert!(body.contains("example.com"), "何を触ったのかは残すこと: {body}");
    }

    /// 進捗の行は伏せない（数字しか無いので伏せる意味が無く、伏せるとバーが壊れる）。
    #[test]
    fn progress_lines_stay_progress() {
        assert!(matches!(
            classify("Receiving objects:  42% (123/456)"),
            Line::Progress(_),
        ));
    }

    /// 画面へ出す 1 行も伏せる。**`explain` は stderr をそのまま貼る経路を持つ。**
    #[test]
    fn the_headline_is_redacted_too() {
        let message = explain("fatal: repository 'https://u:tok3n@example.com/x.git/' not found");
        assert!(!message.contains("tok3n"), "{message}");
    }

    /// **リモートが無ければ永久に警告しない。**
    #[test]
    fn never_warns_without_remotes() {
        assert!(!is_stale(false, None, 100 * DAY, 7));
        assert!(!is_stale(false, Some(0), 100 * DAY, 7));
    }

    #[test]
    fn warns_when_never_fetched() {
        assert!(is_stale(true, None, 100 * DAY, 7));
    }

    #[test]
    fn compares_against_the_threshold() {
        let now = 100 * DAY;
        assert!(!is_stale(true, Some(now - 6 * DAY), now, 7));
        assert!(!is_stale(true, Some(now - 7 * DAY), now, 7), "ちょうどは古くない");
        assert!(is_stale(true, Some(now - 8 * DAY), now, 7));
    }

    /// 閾値 0 で無効にできる（docs/DESIGN.md §8.3）。
    #[test]
    fn zero_disables_the_warning() {
        assert!(!is_stale(true, None, 100 * DAY, 0));
        assert!(!is_stale(true, Some(0), 100 * DAY, 0));
    }

    /// 時計がずれて未来の mtime になっていても「古い」とは言わない。
    #[test]
    fn a_future_timestamp_is_not_stale() {
        let now = 100 * DAY;
        assert!(!is_stale(true, Some(now + 30 * DAY), now, 7));
    }
}
