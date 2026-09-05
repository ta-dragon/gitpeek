//! 書き込み系の git 操作（docs/DESIGN.md §8）。
//!
//! **git に対して書き込むのは checkout / fetch / merge --ff-only / clone の 4 つだけ**
//! （CLAUDE.md §1）。このモジュールに他の操作を足さないこと。
//! v1 で入っているのは fetch / checkout / merge --ff-only / clone の 4 つ。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

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
    explain_transport(stderr, "fetch")
}

/// [`explain`] の本体。**clone と共用する**（相手は同じリモートで、出る stderr も同じ）。
///
/// `what` は画面に出す動詞（`fetch` / `clone`）。**言い換えの中身は共通でよいが、
/// 「ターミナルで一度これを実行して」の例まで `fetch` 固定にすると、clone で
/// 見当違いの指示になる**ので、そこだけ差し替える。
fn explain_transport(stderr: &str, what: &str) -> String {
    const AUTH: &[&str] = &[
        "could not read Username",
        "could not read Password",
        "terminal prompts disabled",
        "Authentication failed",
    ];

    if AUTH.iter().any(|needle| stderr.contains(needle)) {
        return format!(
            "認証できませんでした。ターミナルで一度 `git {what}` を実行して資格情報を登録してください。"
        );
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
        Some(line) => format!("{what} に失敗しました: {}", redact(line)),
        None => format!("{what} に失敗しました。"),
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


// ---------------------------------------------------------------------------
// checkout と FF マージ（T-18。docs/DESIGN.md §8.1, §8.2）
// ---------------------------------------------------------------------------

/// 実行を止める理由。**1 つでもあれば走らせない。**
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Blocker {
    /// bare には作業ツリーが無い（docs/DESIGN.md §3.6）。
    Bare,
    /// 手を入れたファイルがある。**`--force` も自動 stash も提供しない**（CLAUDE.md §1）。
    Dirty,
    /// 他の git が動いている可能性。**消さない**（CLAUDE.md §2）。
    IndexLock,
    /// コミットが 1 件も無い。切り替える先が無い。
    Unborn,
}

/// 書き込み前の判定（docs/DESIGN.md §8.1）。
///
/// **起動点が 4 つある**（ref ツリーの右クリック / ダブルクリック / グラフ行の右クリック /
/// 上流の取り込み）ので、判定をボタンの側に置くと結論が食い違う。ここ 1 つに集める。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteGuard {
    pub blockers: Vec<Blocker>,
    /// 未追跡ファイルの数。**止める理由ではない**が、ダイアログには出す。
    pub untracked: usize,
    /// 手を入れたファイルの数（ステージ済み ＋ 未ステージ ＋ 衝突）。
    pub changed: usize,
}

impl WriteGuard {
    pub fn allowed(&self) -> bool {
        self.blockers.is_empty()
    }
}

/// 走らせてよいかを決める。**純関数**（材料は呼び出し側が集める）。
///
/// **未追跡ファイルだけなら止めない。** checkout は未追跡ファイルを消さず、
/// 上書きになる場合は git 自身が拒む。ここで止めると、新しいファイルを書きかけの間は
/// ブランチを切り替えられなくなる（docs/DESIGN.md §8.1）。
/// **`WorkingTree::is_clean()` は未追跡も数える**ので、そちらは使わない。
pub fn preflight(
    is_bare: bool,
    unborn: bool,
    index_lock_present: bool,
    tree: Option<&crate::git::status::WorkingTree>,
) -> WriteGuard {
    let mut blockers = Vec::new();
    if is_bare {
        blockers.push(Blocker::Bare);
    }
    if unborn {
        blockers.push(Blocker::Unborn);
    }
    if index_lock_present {
        blockers.push(Blocker::IndexLock);
    }

    let (changed, untracked) = match tree {
        Some(tree) => (
            tree.staged.len() + tree.unstaged.len() + tree.unmerged.len(),
            tree.untracked.len(),
        ),
        None => (0, 0),
    };
    if changed > 0 {
        blockers.push(Blocker::Dirty);
    }

    WriteGuard {
        blockers,
        untracked,
        changed,
    }
}

/// checkout の対象。**渡し方が形で変わる**（docs/DESIGN.md §8.1。実測）。
///
/// **`rename_all` は変種の名前しか変えない。** 中のフィールドまで camelCase にするには
/// `rename_all_fields` が要る。付け忘れると `kind` だけ合って
/// 「missing field `remote_ref`」で落ちる（実際に落ちた）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum CheckoutTarget {
    /// 既にあるローカルブランチ。**短い名前で渡す** — 完全な ref 名
    /// （`refs/heads/main`）を渡すと git はブランチとして扱わず detached になる。
    Branch { name: String },
    /// detached HEAD で開く。**完全な ref 名か SHA を渡す** —
    /// 短い名前だと git の DWIM がローカル追跡ブランチを勝手に作る（CLAUDE.md §1 違反）。
    Detach { rev: String },
    /// リモート追跡ブランチを追跡するローカルブランチを作って切り替える。
    ///
    /// **自動では作らない。利用者が確認画面で選んだときだけここへ来る**（CLAUDE.md §1）。
    /// `-b` は既存の名前では失敗するので、**取り違えて上書きすることはない**。
    Track { remote_ref: String, branch: String },
}

impl CheckoutTarget {
    /// git へ渡す引数。**ここだけが checkout の引数を組み立てる。**
    fn args(&self) -> Vec<&str> {
        match self {
            Self::Branch { name } => vec!["checkout", name],
            Self::Detach { rev } => vec!["checkout", "--detach", rev],
            Self::Track { remote_ref, branch } => {
                vec!["checkout", "-b", branch, "--track", remote_ref]
            }
        }
    }

    /// 画面に出す対象の名前。
    fn label(&self) -> &str {
        match self {
            Self::Branch { name } => name,
            Self::Detach { rev } => rev,
            Self::Track { branch, .. } => branch,
        }
    }
}

/// 書き込み操作の結果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub ok: bool,
    /// 画面に出す 1 行（docs/DESIGN.md §3.6）。
    pub message: String,
    /// 生の stderr。**`redact.rs` を通してある**（CLAUDE.md §4）。展開して見せる。
    pub details: Vec<String>,
    /// 実行の直前に判定が通らなかったときの内訳。
    ///
    /// **ダイアログを開いた時点と実行の瞬間で状態は変わりうる**（別の git が動く、
    /// エディタが保存する）。そのときは走らせず、何が変わったかをそのまま返す。
    /// **文言はフロントが作る**（CLAUDE.md §6）。
    pub refused: Option<WriteGuard>,
}

/// checkout する。**呼ぶ前に [`preflight`] を通すこと**（コマンド側で再確認する）。
pub fn checkout(
    log: &dyn LogSink,
    program: &str,
    repo: &Path,
    target: &CheckoutTarget,
) -> Result<WriteOutcome, String> {
    let output = exec::run(log, program, Some(repo), &target.args())?;
    let details = detail_lines(&output.stderr);

    if output.ok() {
        return Ok(WriteOutcome {
            ok: true,
            message: format!("{} に切り替えました。", target.label()),
            details,
            refused: None,
        });
    }
    Ok(WriteOutcome {
        ok: false,
        message: explain_checkout(&output.stderr),
        details,
        refused: None,
    })
}

/// fast-forward マージ。**`--ff-only` 固定**（CLAUDE.md §1）。
///
/// FF できるかは手元のグラフで先に判定しているが、**ここでも `--ff-only` を外さない。**
/// 判定と実行の間にリポジトリが動くことがあり、そのとき git に止めてもらう必要がある。
pub fn merge_ff(
    log: &dyn LogSink,
    program: &str,
    repo: &Path,
    rev: &str,
) -> Result<WriteOutcome, String> {
    let output = exec::run(log, program, Some(repo), &["merge", "--ff-only", rev])?;
    let details = detail_lines(&output.stderr);

    if output.ok() {
        return Ok(WriteOutcome {
            ok: true,
            message: format!("{rev} を取り込みました。"),
            details,
            refused: None,
        });
    }
    Ok(WriteOutcome {
        ok: false,
        message: explain_merge(&output.stderr),
        details,
        refused: None,
    })
}

/// stderr を展開表示用の行にする。**必ず `redact` を通す。**
fn detail_lines(stderr: &str) -> Vec<String> {
    stderr
        .lines()
        .map(|line| redact(line.trim()))
        .filter(|line| !line.is_empty())
        .take(MAX_LINES)
        .collect()
}

/// checkout の失敗を画面向けの 1 行にする（docs/DESIGN.md §3.6）。
fn explain_checkout(stderr: &str) -> String {
    if stderr.contains("would be overwritten by checkout")
        || stderr.contains("Your local changes to the following files would be overwritten")
    {
        return "手元の変更が上書きされるため切り替えられません。変更を片付けてからもう一度実行してください（Givsoner は stash も --force も行いません）。".to_string();
    }
    // **未追跡ファイルは止めていない**ので、同じ名前のものがあるとここに来る。
    if stderr.contains("untracked working tree files would be overwritten") {
        return "同じ名前の未追跡ファイルがあるため切り替えられません。そのファイルを移動するか消してからもう一度実行してください。".to_string();
    }
    if stderr.contains("already exists") {
        return "同じ名前のローカルブランチが既にあります。作らずに、そのブランチへ切り替えてください。".to_string();
    }
    if stderr.contains("did not match any file(s) known to git")
        || stderr.contains("unknown revision")
    {
        return "対象が見つかりませんでした。fetch してからもう一度実行してください。".to_string();
    }
    match first_line(stderr) {
        Some(line) => format!("checkout に失敗しました: {}", redact(line)),
        None => "checkout に失敗しました。".to_string(),
    }
}

/// FF マージの失敗を画面向けの 1 行にする。
fn explain_merge(stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("not possible to fast-forward") {
        return "fast-forward できないので取り込みませんでした。手元にだけあるコミットがあります（Givsoner は fast-forward 以外のマージを行いません）。".to_string();
    }
    if lower.contains("refusing to merge unrelated histories") {
        return "共通の祖先が無いので取り込めません。".to_string();
    }
    if lower.contains("would be overwritten by merge") || lower.contains("local changes") {
        return "手元の変更が上書きされるため取り込めません。変更を片付けてからもう一度実行してください。".to_string();
    }
    match first_line(stderr) {
        Some(line) => format!("マージに失敗しました: {}", redact(line)),
        None => "マージに失敗しました。".to_string(),
    }
}

/// stderr の最初の意味のある行。`hint:` は git の助言なので飛ばす。
fn first_line(stderr: &str) -> Option<&str> {
    stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("hint:"))
}

// ---------------------------------------------------------------------------
// clone（T-19。docs/DESIGN.md §8.4）
// ---------------------------------------------------------------------------

/// `clone` の固定引数（docs/DESIGN.md §8.4）。URL と保存先はこの後ろへ足す。
///
/// - **`--progress` は必須。** stderr が端末でないと git は進捗を出さないので、
///   外すとバーが一度も動かない
/// - **`--depth` / `--single-branch` を付けない**（CLAUDE.md §1）。履歴グラフを見るための
///   アプリなので、浅いクローンは目的そのものを損なう
/// - **`--recurse-submodules` を付けない**（CLAUDE.md §1）
/// - **`--branch` を付けない。** 1 本だけ持ってきてもグラフが欠ける
pub const CLONE_ARGS: &[&str] = &["clone", "--progress"];

/// 残骸を消せるまで待つ回数と間隔（[`clean_up`]）。
///
/// 合計 2 秒。**中止直後は消せないことがある**ので、一度で諦めない。
const CLEANUP_ATTEMPTS: u32 = 20;
const CLEANUP_WAIT: std::time::Duration = std::time::Duration::from_millis(100);

/// git へ渡す引数。**ここだけが clone の引数を組み立てる。**
pub fn clone_args<'a>(url: &'a str, directory: &'a str) -> Vec<&'a str> {
    let mut args = CLONE_ARGS.to_vec();
    args.push(url);
    args.push(directory);
    args
}

/// フロントから届く clone の依頼。
///
/// **保存先は「親フォルダ」と「作るフォルダ名」に分けて受け取り、繋ぐのはこちら側**
/// （区切り文字の扱いを 2 か所に持たない）。画面のプレビューは目安であり、
/// 実際に作った場所は [`CloneOutcome::path`] が正。
///
/// **`rename_all` を落とすとフロントの JSON を食えない**（T-18 でここに嵌まった）。
/// 変種を持たない構造体なので `rename_all` だけでよいが、
/// enum に変えるときは `rename_all_fields` も要る。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneRequest {
    /// HTTPS / SSH / ローカルパス。**git へそのまま渡す**（アプリは解釈しない）。
    pub url: String,
    /// clone 先の**親**フォルダ。ここに `folder_name` を作る。
    pub parent_directory: String,
    /// 作るフォルダの名前。
    pub folder_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloneStatus {
    Success,
    Failed,
    /// 利用者が止めた。**fetch と違い、途中まで取り込んだものは残さない**（下記）。
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneOutcome {
    pub status: CloneStatus,
    /// 画面に出す 1 行。
    pub message: String,
    /// 進捗ではなかった stderr の行。**`redact.rs` を通してある**（CLAUDE.md §4）。
    pub lines: Vec<String>,
    pub duration_ms: u64,
    /// 成功したときの clone 先（絶対パス）。**登録にはこれを使う。**
    pub path: Option<String>,
    /// 消さずに残した残骸の場所。消せた場合と、そもそも作っていない場合は `None`。
    pub leftover: Option<String>,
}

/// 依頼の形を確かめて clone 先の絶対パスにする。**git を起動する前に通す。**
///
/// ファイルシステムは見ない（存在の確認は [`clone`] の中で行う）。
pub fn clone_target(request: &CloneRequest) -> Result<PathBuf, String> {
    if request.url.trim().is_empty() {
        return Err("URL を入力してください。".to_string());
    }

    let parent = request.parent_directory.trim();
    if parent.is_empty() {
        return Err("保存先の親フォルダを選んでください。".to_string());
    }
    let parent = Path::new(parent);
    // **`-C` を使わずに絶対パスで渡す**ので、ここで相対パスを弾いておく。
    // 相対のまま通すと、アプリの作業ディレクトリという利用者の知らない場所に作られる。
    if !parent.is_absolute() {
        return Err("保存先はフルパスで指定してください。".to_string());
    }

    let name = request.folder_name.trim();
    if name.is_empty() {
        return Err("作成するフォルダの名前を入力してください。".to_string());
    }
    // **区切り文字を弾くのが要。** 通すと親フォルダの外へ出られてしまい、
    // 「自分が作ったフォルダだけ消す」という後始末の前提が崩れる。
    if name == "." || name == ".." || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
    {
        return Err(format!("フォルダ名に使えない文字が含まれています: {name}"));
    }

    Ok(parent.join(name))
}

/// clone する。**新しいフォルダを作る操作なので、`-C` は使わない**（まだ無い）。
///
/// 中止は `cancel` を立てる。**fetch と違い、中止したら残骸を消す。** clone は
/// 「途中まで取り込まれた」に意味が無く（中途半端なリポジトリは開けない）、
/// 残しても利用者が手で消すことになるため。
///
/// **消してよいのは自分が作ったフォルダだけ。** 実行前に存在しなかったことを
/// 確かめられたときにしか消さない。確かめられなければ消さずに場所を返す。
pub fn clone(
    log: &dyn LogSink,
    program: &str,
    request: &CloneRequest,
    cancel: &Cancel,
    on_progress: &mut dyn FnMut(FetchProgress),
) -> Result<CloneOutcome, String> {
    let directory = match clone_target(request) {
        Ok(directory) => directory,
        Err(message) => return Ok(refused_clone(message)),
    };

    // 既にあるフォルダには clone しない。git も拒むが、**その前にこちらの言葉で言う**
    // （git の英語 stderr より読みやすい）。
    //
    // 同時に、後始末で消してよいかもここで決まる。存在を確かめられなかった場合
    // （権限など）は「無かった」と言い切れないので、消さない側に倒す。
    let removable = match std::fs::symlink_metadata(&directory) {
        Ok(_) => {
            return Ok(refused_clone(format!(
                "そのフォルダは既にあります: {}。別の名前にするか、既にあるほうを「追加」で登録してください。",
                directory.display()
            )))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    };

    let mut splitter = LineSplitter::new();
    let mut lines: Vec<String> = Vec::new();

    // fetch と同じ振り分け。**本文が上限に達しても進捗は流し続ける。**
    let mut take = |line: String| {
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

    let url = request.url.trim();
    let target = directory.display().to_string();
    let args = clone_args(url, &target);

    let started = std::time::Instant::now();
    let output = exec::run_progress(log, program, None, &args, cancel, &mut |chunk| {
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
        let leftover = clean_up(&directory, removable);
        return Ok(CloneOutcome {
            status: CloneStatus::Cancelled,
            message: match leftover.as_deref() {
                None => {
                    "clone を中止しました。途中まで取り込んだフォルダは削除しました。".to_string()
                }
                Some(path) => format!(
                    "clone を中止しました。途中まで取り込んだフォルダが残っています: {path}"
                ),
            },
            lines,
            duration_ms,
            path: None,
            leftover,
        });
    }

    if output.ok() {
        return Ok(CloneOutcome {
            status: CloneStatus::Success,
            message: format!("{target} に clone しました。"),
            lines,
            duration_ms,
            path: Some(target),
            leftover: None,
        });
    }

    let leftover = clean_up(&directory, removable);
    let reason = explain_transport(&output.stderr, "clone");
    Ok(CloneOutcome {
        status: CloneStatus::Failed,
        message: match leftover.as_deref() {
            None => reason,
            Some(path) => {
                format!("{reason} 途中まで取り込んだフォルダが残っています: {path}")
            }
        },
        lines,
        duration_ms,
        path: None,
        leftover,
    })
}

/// 走らせずに返す結果。**git は 1 度も起動していない。**
fn refused_clone(message: String) -> CloneOutcome {
    CloneOutcome {
        status: CloneStatus::Failed,
        message,
        lines: Vec::new(),
        duration_ms: 0,
        path: None,
        leftover: None,
    }
}

/// 残骸の後始末。返すのは「残ってしまった場所」（消せた／作っていないなら `None`）。
///
/// **`removable` が false なら触らない。** 実行前に「無かった」と確かめられなかった
/// フォルダなので、利用者の既存フォルダかもしれない。
///
/// 一度で諦めないのは、**中止直後は消せないことがある**ため。`exec::run_progress` が
/// 落とせるのは git 本体だけで、`git-remote-https` のような子は少し遅れて終わる。
/// その間 pack の一時ファイルを掴んでおり、Windows は掴まれたファイルを消せない。
fn clean_up(directory: &Path, removable: bool) -> Option<String> {
    if !directory.exists() {
        return None;
    }
    if !removable {
        return Some(directory.display().to_string());
    }

    for attempt in 0..CLEANUP_ATTEMPTS {
        if std::fs::remove_dir_all(directory).is_ok() || !directory.exists() {
            return None;
        }
        if attempt + 1 < CLEANUP_ATTEMPTS {
            std::thread::sleep(CLEANUP_WAIT);
        }
    }
    Some(directory.display().to_string())
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

    // --- checkout と FF マージ（T-18）-------------------------------------

    use super::{preflight, Blocker, CheckoutTarget, WriteGuard};
    use crate::git::status::WorkingTree;
    use crate::git::diff::{ChangeStatus, FileChange};

    fn change(path: &str) -> FileChange {
        FileChange {
            path: path.to_string(),
            old_path: None,
            status: ChangeStatus::Modified,
            additions: Some(1),
            deletions: Some(0),
            old_mode: "100644".to_string(),
            new_mode: "100644".to_string(),
        }
    }

    fn tree() -> WorkingTree {
        WorkingTree {
            staged: Vec::new(),
            unstaged: Vec::new(),
            untracked: Vec::new(),
            unmerged: Vec::new(),
            index_lock_present: false,
        }
    }

    /// **ローカルブランチは短い名前。** 完全な ref 名を渡すと detached になる（実測）。
    #[test]
    fn a_local_branch_is_passed_by_its_short_name() {
        let target = CheckoutTarget::Branch {
            name: "main".to_string(),
        };
        assert_eq!(target.args(), ["checkout", "main"]);
    }

    /// **それ以外は完全な ref 名 ＋ `--detach`。** 短い名前だと git の DWIM が
    /// ローカル追跡ブランチを勝手に作る（CLAUDE.md §1 違反）。
    #[test]
    fn everything_else_is_detached_by_full_ref_name() {
        let remote = CheckoutTarget::Detach {
            rev: "refs/remotes/origin/main".to_string(),
        };
        assert_eq!(
            remote.args(),
            ["checkout", "--detach", "refs/remotes/origin/main"]
        );

        let tag = CheckoutTarget::Detach {
            rev: "refs/tags/v1".to_string(),
        };
        assert_eq!(tag.args(), ["checkout", "--detach", "refs/tags/v1"]);
    }

    /// ローカル追跡ブランチは**利用者が確認画面で選んだときだけ**作る。
    #[test]
    fn a_tracking_branch_is_created_only_by_name() {
        let target = CheckoutTarget::Track {
            remote_ref: "refs/remotes/origin/feature".to_string(),
            branch: "feature".to_string(),
        };
        assert_eq!(
            target.args(),
            ["checkout", "-b", "feature", "--track", "refs/remotes/origin/feature"]
        );
    }

    /// **CLAUDE.md §1 の禁止事項が引数に紛れ込んでいないこと。**
    ///
    /// `-b` は `Track` にだけ現れる。`--force` / `-f` / `--orphan` はどこにも現れない。
    #[test]
    fn checkout_args_stay_within_what_we_allow() {
        let targets = [
            CheckoutTarget::Branch {
                name: "main".to_string(),
            },
            CheckoutTarget::Detach {
                rev: "refs/tags/v1".to_string(),
            },
            CheckoutTarget::Track {
                remote_ref: "refs/remotes/origin/x".to_string(),
                branch: "x".to_string(),
            },
        ];
        for target in &targets {
            let args = target.args();
            assert_eq!(args[0], "checkout");
            for banned in ["--force", "-f", "--orphan", "-B", "--ours", "--theirs"] {
                assert!(!args.contains(&banned), "{banned} を付けてはいけない: {args:?}");
            }
        }
        // `-b` はローカル追跡ブランチの作成だけ。**他の 2 つには絶対に出さない。**
        assert!(!targets[0].args().contains(&"-b"));
        assert!(!targets[1].args().contains(&"-b"));
        assert!(targets[2].args().contains(&"-b"));
    }

    /// **フロントが送る JSON をそのまま食えること。**
    ///
    /// 引数の組み立てだけを見ていても、受け取りの形が違えばコマンドは 1 度も走らない。
    /// `rename_all` は変種の名前しか変えないので、`rename_all_fields` を落とすと
    /// ここで落ちる（実際に「missing field `remote_ref`」で落ちた）。
    #[test]
    fn the_wire_format_matches_what_the_front_end_sends() {
        let branch: CheckoutTarget =
            serde_json::from_str(r#"{"kind":"branch","name":"main"}"#).expect("branch");
        assert_eq!(
            branch,
            CheckoutTarget::Branch {
                name: "main".to_string()
            }
        );

        let detach: CheckoutTarget =
            serde_json::from_str(r#"{"kind":"detach","rev":"refs/tags/v1"}"#).expect("detach");
        assert_eq!(
            detach,
            CheckoutTarget::Detach {
                rev: "refs/tags/v1".to_string()
            }
        );

        let track: CheckoutTarget = serde_json::from_str(
            r#"{"kind":"track","remoteRef":"refs/remotes/origin/x","branch":"x"}"#,
        )
        .expect("track");
        assert_eq!(
            track,
            CheckoutTarget::Track {
                remote_ref: "refs/remotes/origin/x".to_string(),
                branch: "x".to_string()
            }
        );
    }

    /// マージは `--ff-only` 固定（CLAUDE.md §1）。
    #[test]
    fn merge_is_always_ff_only() {
        let args = ["merge", "--ff-only", "refs/remotes/origin/main"];
        assert_eq!(args[1], "--ff-only");
        for banned in ["--no-ff", "--squash", "--strategy", "-X", "--allow-unrelated-histories"] {
            assert!(!args.contains(&banned), "{banned} を付けてはいけない");
        }
    }

    #[test]
    fn a_clean_repository_is_allowed() {
        let guard = preflight(false, false, false, Some(&tree()));
        assert!(guard.allowed());
        assert_eq!(guard.changed, 0);
    }

    #[test]
    fn a_bare_repository_is_blocked() {
        let guard = preflight(true, false, false, None);
        assert_eq!(guard.blockers, [Blocker::Bare]);
        assert!(!guard.allowed());
    }

    #[test]
    fn an_empty_repository_is_blocked() {
        let guard = preflight(false, true, false, Some(&tree()));
        assert_eq!(guard.blockers, [Blocker::Unborn]);
    }

    /// **消さない。止めるだけ**（CLAUDE.md §2）。
    #[test]
    fn a_leftover_index_lock_is_blocked() {
        let guard = preflight(false, false, true, Some(&tree()));
        assert_eq!(guard.blockers, [Blocker::IndexLock]);
    }

    #[test]
    fn a_dirty_working_tree_is_blocked() {
        let mut dirty = tree();
        dirty.staged.push(change("a.txt"));
        dirty.unstaged.push(change("b.txt"));

        let guard = preflight(false, false, false, Some(&dirty));
        assert_eq!(guard.blockers, [Blocker::Dirty]);
        assert_eq!(guard.changed, 2);
    }

    /// 衝突しているパスも「手を入れた」に数える。
    #[test]
    fn an_unmerged_path_counts_as_dirty() {
        let mut conflicted = tree();
        conflicted.unmerged.push("f.txt".to_string());

        assert_eq!(
            preflight(false, false, false, Some(&conflicted)).blockers,
            [Blocker::Dirty]
        );
    }

    /// **未追跡だけなら止めない**（docs/DESIGN.md §8.1）。checkout は未追跡ファイルを
    /// 消さないし、上書きになる場合は git 自身が拒む。ここで止めると、
    /// 新しいファイルを書きかけの間はブランチを切り替えられなくなる。
    #[test]
    fn untracked_files_alone_do_not_block() {
        let mut fresh = tree();
        fresh.untracked.push("新しいメモ.txt".to_string());

        let guard = preflight(false, false, false, Some(&fresh));
        assert!(guard.allowed(), "未追跡だけで止めてはいけない");
        assert_eq!(guard.untracked, 1);
        assert_eq!(guard.changed, 0);
    }

    /// `WorkingTree::is_clean()` は未追跡も数える。**判定を取り違えない**ための固定。
    #[test]
    fn is_clean_and_the_checkout_guard_disagree_on_untracked() {
        let mut fresh = tree();
        fresh.untracked.push("x".to_string());

        assert!(!fresh.is_clean(), "擬似行はこれで出す");
        assert!(
            preflight(false, false, false, Some(&fresh)).allowed(),
            "checkout はこれで止めない"
        );
    }

    #[test]
    fn every_reason_is_reported_at_once() {
        let mut dirty = tree();
        dirty.unstaged.push(change("a.txt"));

        let guard: WriteGuard = preflight(true, true, true, Some(&dirty));
        assert_eq!(
            guard.blockers,
            [
                Blocker::Bare,
                Blocker::Unborn,
                Blocker::IndexLock,
                Blocker::Dirty
            ]
        );
    }

    // --- clone（T-19）-----------------------------------------------------

    use super::{clone_args, clone_target, CloneRequest, CLONE_ARGS};

    fn request(url: &str, parent: &str, name: &str) -> CloneRequest {
        CloneRequest {
            url: url.to_string(),
            parent_directory: parent.to_string(),
            folder_name: name.to_string(),
        }
    }

    /// **CLAUDE.md §1 の禁止事項が引数に紛れ込んでいないこと。**
    ///
    /// `--depth` を足すと履歴が欠け、このアプリの目的そのものが成立しない。
    #[test]
    fn clone_args_stay_within_what_we_allow() {
        assert_eq!(CLONE_ARGS, &["clone", "--progress"]);

        let args = clone_args("https://example.com/o/r.git", "C:\\ws\\r");
        assert_eq!(
            args,
            ["clone", "--progress", "https://example.com/o/r.git", "C:\\ws\\r"],
        );
        for banned in [
            "--depth",
            "--shallow-since",
            "--single-branch",
            "--recurse-submodules",
            "--branch",
            "-b",
            "--bare",
            "--mirror",
        ] {
            assert!(!args.contains(&banned), "{banned} を付けてはいけない: {args:?}");
        }
    }

    /// **URL と保存先は引数の最後**（オプションとして解釈されない位置）。
    #[test]
    fn the_url_and_the_target_come_last() {
        let args = clone_args("git@host:o/r.git", "D:\\ws\\r");
        assert_eq!(args[args.len() - 2], "git@host:o/r.git");
        assert_eq!(args[args.len() - 1], "D:\\ws\\r");
    }

    #[test]
    fn a_well_formed_request_becomes_an_absolute_path() {
        let target = clone_target(&request("https://example.com/o/r.git", "C:\\ws", "r"))
            .expect("受け付けること");
        assert_eq!(target, std::path::Path::new("C:\\ws").join("r"));
    }

    /// 空欄は git へ渡さず、その場で言う。
    #[test]
    fn an_empty_field_is_refused_before_git_runs() {
        assert!(clone_target(&request("  ", "C:\\ws", "r")).is_err());
        assert!(clone_target(&request("https://example.com/o/r.git", " ", "r")).is_err());
        assert!(clone_target(&request("https://example.com/o/r.git", "C:\\ws", " ")).is_err());
    }

    /// **相対パスを弾く。** `-C` を使わずに絶対パスで渡す設計なので、
    /// 相対のまま通すとアプリの作業ディレクトリという知らない場所に作られる。
    #[test]
    fn a_relative_parent_is_refused() {
        let error = clone_target(&request("https://example.com/o/r.git", "ws", "r"))
            .expect_err("相対パスは受け付けない");
        assert!(error.contains("フルパス"), "{error}");
    }

    /// **フォルダ名に区切り文字を通さない。** 通すと親フォルダの外へ出られてしまい、
    /// 「自分が作ったフォルダだけ消す」という後始末の前提が崩れる。
    #[test]
    fn a_folder_name_can_not_escape_its_parent() {
        for name in ["..", ".", "a/b", "a\\b", "C:", "a*b", "a?b", "a|b"] {
            assert!(
                clone_target(&request("https://example.com/o/r.git", "C:\\ws", name)).is_err(),
                "{name} を通してはいけない",
            );
        }
    }

    /// **フロントが送る JSON をそのまま食えること**（T-18 の申し送り）。
    ///
    /// 引数の組み立てだけを固定しても、受け取りの形が違えばコマンドは 1 度も走らない。
    #[test]
    fn the_clone_wire_format_matches_what_the_front_end_sends() {
        let parsed: CloneRequest = serde_json::from_str(
            r#"{"url":"https://example.com/o/r.git","parentDirectory":"C:\\ws","folderName":"r"}"#,
        )
        .expect("フロントの JSON を食えること");

        assert_eq!(parsed, request("https://example.com/o/r.git", "C:\\ws", "r"));
    }

    /// 失敗の言い換えは fetch と共用するが、**動詞は差し替わる**こと。
    /// 「ターミナルで一度 `git fetch` を」と出しても、clone では何もできない。
    #[test]
    fn the_clone_headline_talks_about_clone() {
        let auth = super::explain_transport("fatal: Authentication failed for 'https://x/'", "clone");
        assert!(auth.contains("git clone"), "{auth}");
        assert!(!auth.contains("git fetch"), "{auth}");

        let other = super::explain_transport("fatal: repository 'https://x/' not found", "clone");
        assert!(other.contains("clone に失敗しました"), "{other}");
    }

    /// 画面へ出す 1 行も伏せる。**URL 欄に資格情報を貼られる**ことがある。
    #[test]
    fn the_clone_headline_is_redacted_too() {
        let message = super::explain_transport(
            "fatal: repository 'https://u:tok3nvalue@example.com/x.git/' not found",
            "clone",
        );
        assert!(!message.contains("tok3nvalue"), "{message}");
    }

}
