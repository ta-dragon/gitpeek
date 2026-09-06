//! レビューの計画と実行（T-22。DESIGN.md §10.4〜§10.7 / CLAUDE.md §7）。
//!
//! ここが守っていること:
//!
//! - **モデルへ渡すのは パス ＋ unified diff ＋ コミットメッセージ ＋ skill 本文だけ。**
//!   ファイル全文もリポジトリ構成も渡さない
//! - **skill 本文は [`SkillEntry::usable_body`] からしか取らない。** `preview` は
//!   画面で読ませるためのもので、未信頼の skill にも入っている（CLAUDE.md §4）
//! - **HTTP は [`crate::llm::client`] を通す。** ここから `ureq` を直に触らない
//! - **git は [`crate::git::exec`] を通す**（`diff` / `commit_message` 経由）
//! - **1 ファイルの失敗で全体を止めない。** そのファイルに理由を残して次へ進む
//! - **構造化に失敗してもレビューを捨てない。** 生出力を Markdown として残す
//!
//! 差分本文は **[`FileDiff`] の hunks から組み立てる**。`git diff` の生出力を
//! 別経路で取り直さないのは、[`crate::git::diff::file_diff`] が
//! **文字コードの判別を済ませてある**ため（Shift_JIS のファイルをそのまま載せると
//! JSON が壊れる）。組み立てが純関数なので、**hunk 分割が「渡す hunk を選ぶだけ」**になる。

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::commandlog::LogSink;
use crate::git::diff::{
    self, ChangeStatus, DiffOptions, DiffSource, DiffTarget, FileChange, FileDiff, Hunk,
};
use crate::git::exec::Cancel;
use crate::llm::client::{self, ChatOutcome, ChatTurn, LlmError, RetryHint};
use crate::llm::skill::{self, SkillEntry, SkillOrigin};
use crate::store::settings::LlmProfile;

/// 見積もりに使う「1 トークンあたりの文字数」（DESIGN.md §10.4）。
///
/// **粗い見積で足りる**という決定に従う。日本語では大きく外れる（1 文字 ≒ 1 トークン）が、
/// 外したときは**接続先が返す超過エラーで拾う**（[`RetryHint::SplitInput`]）。
const CHARS_PER_TOKEN: u32 = 4;

/// 応答ぶんとは別に空けておくトークン数。指示文と往復の余白。
const OVERHEAD_TOKENS: u32 = 512;

/// 予算が読めないときに使う最低限の幅。`context_window` が壊れた値でも 0 にしない。
const MIN_BUDGET_TOKENS: u32 = 1_024;

/// 全体サマリに載せるファイルの上限。**予算より先にここで頭打ちにする。**
const SUMMARY_MAX_FILES: usize = 200;

/// 指摘の重さ。**4 つ以外は受け取らない**（未知の値は [`Severity::Info`] へ寄せる）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Critical,
    Major,
    Minor,
    Info,
}

impl Severity {
    /// モデルが書いた文字列を読む。**知らない値は捨てずに `Info` へ寄せる** —
    /// ラベルが雑なことより、指摘そのものが消えるほうが困る。
    fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "critical" => Self::Critical,
            "major" => Self::Major,
            "minor" => Self::Minor,
            _ => Self::Info,
        }
    }
}

/// 指摘 1 件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub file: String,
    /// 差分の中の行。**モデルが書かなければ `None`**（無理に 0 を入れない）。
    pub line: Option<u32>,
    pub severity: Severity,
    pub title: String,
    pub message: String,
}

/// モデルの応答 1 つ分。**構造化できたかどうかの両方をここで持つ。**
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReviewText {
    pub summary: String,
    pub findings: Vec<Finding>,
    /// 構造化に失敗したときの生出力。**捨てない**（DESIGN.md §10.6）。
    pub markdown: Option<String>,
    /// `markdown` が入っている理由。画面はこれをそのまま添える。
    pub fallback_reason: Option<String>,
}

impl ReviewText {
    fn is_empty(&self) -> bool {
        self.summary.is_empty() && self.findings.is_empty() && self.markdown.is_none()
    }
}

/// 一覧に出す skill。**本文は入れない**（webview へ渡すものなので）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedSkill {
    pub name: String,
    pub origin: SkillOrigin,
}

/// 実行前に見せる 1 ファイル。**投げないものも消さずに理由付きで残す**（CLAUDE.md §6）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: ChangeStatus,
    pub tokens_estimate: u32,
    /// 分けて投げる回数。**2 以上なら「hunk 分割されます」。**
    pub parts: usize,
    /// 投げない理由。`None` なら投げる。
    pub skipped: Option<String>,
}

/// 実行前パネルへ渡す一式（DESIGN.md §10.4）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlan {
    pub files: Vec<PlannedFile>,
    pub skills: Vec<PlannedSkill>,
    pub tokens_estimate: u32,
    /// 実行できない理由。**そのまま画面に出す**（押せない理由を消さない）。
    pub blocked: Option<String>,
}

/// ファイル 1 つ分の結果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFileResult {
    pub path: String,
    pub old_path: Option<String>,
    /// 実際に投げた回数。
    pub parts: usize,
    pub text: Option<ReviewText>,
    /// **このファイルだけの失敗。** 全体は止まらない。
    pub error: Option<LlmError>,
    pub tokens_estimate: u32,
    pub elapsed_ms: u64,
}

/// レビュー 1 回分。**T-23 はこれをそのまま履歴へ積む。**
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRun {
    pub run_id: String,
    pub profile_id: String,
    pub model: String,
    pub source: DiffSource,
    pub skills: Vec<PlannedSkill>,
    pub files: Vec<ReviewFileResult>,
    pub summary: Option<ReviewText>,
    /// 失敗したファイル数。**サマリに出す「N 件失敗」の正はこちら**（本文ではない）。
    pub failed: usize,
    pub cancelled: bool,
    pub started_at: i64,
    pub elapsed_ms: u64,
}

/// 途中経過。**どのファイルのものかを必ず添える**（並列度 2 以上で混ざるため）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ReviewEvent {
    Started {
        total: usize,
    },
    FileStarted {
        index: usize,
        path: String,
    },
    /// マスク済みの差分。**繋ぐと本文になる。**
    Delta {
        index: usize,
        text: String,
    },
    FileDone {
        index: usize,
        result: Box<ReviewFileResult>,
    },
    SummaryStarted,
    SummaryDelta {
        text: String,
    },
    SummaryDone {
        summary: Option<ReviewText>,
    },
}

/// 進捗の受け皿。**Tauri に触らせないための境界**（`commandlog::LogSink` と同じ形）。
pub trait ReviewSink: Sync {
    fn report(&self, event: ReviewEvent);
}

/// 何も見ない受け皿。テストと、進捗が要らない呼び出し用。
pub struct NoSink;

impl ReviewSink for NoSink {
    fn report(&self, _event: ReviewEvent) {}
}

/// 通信に要るものだけ。**並列で走る側はこれしか持たない。**
///
/// `ReviewContext` をそのまま渡すと、コマンドログの記録先（`&dyn LogSink`）が
/// スレッドをまたぐことになる。git を呼ぶのは並列に入る前だけなので、
/// **持ち込む必要が無いものは持ち込まない。**
#[derive(Clone, Copy)]
struct Endpoint<'a> {
    profile: &'a LlmProfile,
    api_key: &'a str,
}

/// 実行に要るもの一式。
pub struct ReviewContext<'a> {
    pub log: &'a dyn LogSink,
    pub program: &'a str,
    pub repo: &'a Path,
    pub source: &'a DiffSource,
    pub profile: &'a LlmProfile,
    pub api_key: &'a str,
    /// 読み込み済みの skill 一覧。**絞り込みは [`SkillEntry::active`] を通す。**
    pub skills: &'a [SkillEntry],
    /// `-U<N>`（DESIGN.md §10.5 は `-U10`）。
    pub context_lines: u32,
    pub concurrency: u8,
}

/// 見積もり（DESIGN.md §10.4）。**文字数 ÷ 4。**
///
/// 切り上げる — 「0 トークン」で予算内に見えるファイルを作らない。
pub fn estimate_tokens(text: &str) -> u32 {
    let chars = u32::try_from(text.chars().count()).unwrap_or(u32::MAX);
    chars.div_ceil(CHARS_PER_TOKEN)
}

/// 1 回の要求に載せられるトークン数。
fn budget(profile: &LlmProfile) -> u32 {
    profile
        .context_window
        .saturating_sub(profile.max_tokens)
        .saturating_sub(OVERHEAD_TOKENS)
        .max(MIN_BUDGET_TOKENS)
}

/// unified diff を組み立てる（純関数）。
///
/// **`git diff` の生出力を取り直さない。** [`FileDiff`] は文字コードの判別を
/// 済ませてあるので、こちらから組み立てるほうが安全で、hunk 分割もそのまま書ける。
///
/// `diff --git` や `index` の行は付けない。パスと変更の種類は
/// [`file_header`] が読める形で書いてある。
pub fn unified_text(hunks: &[Hunk]) -> String {
    let mut out = String::new();
    for hunk in hunks {
        out.push_str(&format!(
            "@@ -{},{} +{},{} @@",
            hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
        ));
        if !hunk.heading.is_empty() {
            out.push(' ');
            out.push_str(&hunk.heading);
        }
        out.push('\n');

        for line in &hunk.lines {
            out.push(match line.kind {
                diff::DiffLineKind::Context => ' ',
                diff::DiffLineKind::Added => '+',
                diff::DiffLineKind::Removed => '-',
            });
            out.push_str(&line.text);
            out.push('\n');
            // **末尾に改行が無い行**。git が付ける印をそのまま添える。
            if line.ending.is_none() {
                out.push_str("\\ No newline at end of file\n");
            }
        }
    }
    out
}

/// ファイルの見出し。**リネームは「旧 → 新」で書く**（パスだけだと片方が消える）。
pub fn file_header(change: &FileChange) -> String {
    let what = match change.status {
        ChangeStatus::Added => "追加",
        ChangeStatus::Modified => "変更",
        ChangeStatus::Deleted => "削除",
        ChangeStatus::Renamed => "リネーム",
        ChangeStatus::Copied => "コピー",
        ChangeStatus::TypeChanged => "型変更",
        ChangeStatus::Unknown => "変更",
    };
    match &change.old_path {
        Some(old) if *old != change.path => {
            format!("ファイル: {} → {}\n変更の種類: {what}", old, change.path)
        }
        _ => format!("ファイル: {}\n変更の種類: {what}", change.path),
    }
}

/// hunk を予算に収まる塊へ分ける（純関数）。
///
/// **1 つの hunk だけで予算を超えるときは、それ以上割れないのでそのまま 1 塊にする。**
/// hunk が 0 個なら空を返す（投げるものが無い）。
pub fn split_hunks(hunks: &[Hunk], budget_tokens: u32) -> Vec<Vec<Hunk>> {
    if hunks.is_empty() {
        return Vec::new();
    }
    let whole = estimate_tokens(&unified_text(hunks));
    if whole <= budget_tokens {
        return vec![hunks.to_vec()];
    }

    let mut parts: Vec<Vec<Hunk>> = Vec::new();
    let mut current: Vec<Hunk> = Vec::new();
    let mut current_tokens = 0;

    for hunk in hunks {
        let one = estimate_tokens(&unified_text(std::slice::from_ref(hunk)));
        if !current.is_empty() && current_tokens + one > budget_tokens {
            parts.push(std::mem::take(&mut current));
            current_tokens = 0;
        }
        current.push(hunk.clone());
        current_tokens += one;
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

/// この変更に当てはまる skill（DESIGN.md §11.3）。
///
/// **絞り込みは [`SkillEntry::active`] を先に通す** — 隠されたもの・使わないもの・
/// 信頼していないものはここへ来ない。
fn skills_for<'a>(skills: &'a [SkillEntry], paths: &[String]) -> Vec<&'a SkillEntry> {
    SkillEntry::active(skills)
        .into_iter()
        .filter(|entry| skill::matches_changes(entry, paths))
        .collect()
}

fn planned(skills: &[&SkillEntry]) -> Vec<PlannedSkill> {
    skills
        .iter()
        .map(|entry| PlannedSkill {
            name: entry.name.clone(),
            origin: entry.origin,
        })
        .collect()
}

/// system プロンプト。**要求する JSON はここで決める**（skill は観点だけを書く）。
///
/// skill 本文は [`SkillEntry::usable_body`] からしか取らない。`preview` を使わない。
pub fn system_prompt(skills: &[&SkillEntry]) -> String {
    let mut out = String::from(
        "あなたはコードレビューを行います。渡された差分だけを根拠に、\
         下記の JSON だけを出力してください。JSON の前後に説明文やコードフェンスを付けないでください。\n\n\
         {\n  \"summary\": \"この変更の要約\",\n  \"findings\": [\n    {\n      \
         \"file\": \"パス\",\n      \"line\": 42,\n      \
         \"severity\": \"critical | major | minor | info\",\n      \
         \"title\": \"短い見出し\",\n      \"message\": \"詳細な指摘\"\n    }\n  ]\n}\n\n\
         - 指摘が無ければ findings は空の配列にしてください\n\
         - line には差分に現れる行だけを書いてください。差分に無い行番号を書かないでください\n\
         - ファイル全文もリポジトリ構成も渡されません。差分から読み取れないことは推測せず、\
         その旨を書いてください\n",
    );

    for entry in skills {
        // **`usable_body()` からしか取らない。** 信頼していないものはここが `None`。
        let Some(body) = entry.usable_body() else {
            continue;
        };
        out.push_str("\n---\n# レビュー観点: ");
        out.push_str(&entry.name);
        out.push('\n');
        out.push_str(&body);
        out.push('\n');
    }
    out
}

/// user プロンプト。**渡すのはここに書いてあるものだけ。**
pub fn user_prompt(change: &FileChange, unified: &str, commit_message: Option<&str>, part: Option<(usize, usize)>) -> String {
    let mut out = file_header(change);
    if let Some((index, total)) = part {
        // 分けて投げたことを隠さない。**全体を見ていないことを前提に読ませる。**
        out.push_str(&format!(
            "\n注記: このファイルは大きいので {total} 回に分けています（{}/{total} 回目）。\
             ここに無い部分については書かないでください。",
            index + 1
        ));
    }
    if let Some(message) = commit_message {
        out.push_str("\n\nコミットメッセージ:\n");
        out.push_str(message.trim_end());
    }
    out.push_str("\n\n差分:\n");
    out.push_str(unified);
    out
}

/// 全体サマリの user プロンプト。**差分は渡さない**（各ファイルの要約と見出しだけ）。
pub fn summary_prompt(files: &[ReviewFileResult], failed: usize, budget_tokens: u32) -> String {
    let mut out = String::from(
        "以下は、変更されたファイルを 1 つずつレビューした結果です。\
         全体としての要約を同じ JSON 形式で書いてください。\
         findings には、複数のファイルにまたがる問題だけを書いてください。\n",
    );
    if failed > 0 {
        out.push_str(&format!(
            "\n注記: {failed} 件のファイルはレビューに失敗しました。\
             その内容は下に含まれていません。\n"
        ));
    }

    let mut left = 0;
    for (index, file) in files.iter().enumerate() {
        let Some(text) = &file.text else { continue };
        let mut block = format!("\n## {}\n", file.path);
        if !text.summary.is_empty() {
            block.push_str(&text.summary);
            block.push('\n');
        }
        for finding in &text.findings {
            block.push_str(&format!("- [{:?}] {}\n", finding.severity, finding.title));
        }
        // 構造化に失敗したファイルは見出しが無い。**要約が空でも名前は出す。**
        if text.summary.is_empty() && text.findings.is_empty() {
            block.push_str("（構造化に失敗しました）\n");
        }

        if index >= SUMMARY_MAX_FILES
            || estimate_tokens(&out) + estimate_tokens(&block) > budget_tokens
        {
            left = files.len() - index;
            break;
        }
        out.push_str(&block);
    }
    if left > 0 {
        out.push_str(&format!(
            "\n（以下 {left} 件は長さの都合で要約に含めていません）\n"
        ));
    }
    out
}

/// 応答を [`ReviewText`] にする。**読めなければ Markdown として残す**（DESIGN.md §10.6）。
pub fn parse_review(content: &str, fallback_file: &str, reason_hint: Option<&str>) -> ReviewText {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return ReviewText {
            markdown: Some(String::new()),
            fallback_reason: Some(
                reason_hint
                    .unwrap_or("返事が空でした。モデルと接続先を確かめてください。")
                    .to_string(),
            ),
            ..ReviewText::default()
        };
    }

    for candidate in json_candidates(trimmed) {
        let Ok(parsed) = serde_json::from_str::<RawReview>(&candidate) else {
            continue;
        };
        return RawReview::into_text(parsed, fallback_file);
    }

    ReviewText {
        markdown: Some(trimmed.to_string()),
        fallback_reason: Some(
            reason_hint
                .unwrap_or("決まった形で返ってこなかったので、モデルの出力をそのまま出しています。")
                .to_string(),
        ),
        ..ReviewText::default()
    }
}

/// JSON として読めそうな部分を、**確からしい順に**返す（純関数）。
///
/// 小型モデルはコードフェンスで囲んだり、前後に一言添えたりする。
/// 素で読めるならそれが一番確かなので、繕いは後ろに置く。
fn json_candidates(text: &str) -> Vec<String> {
    let mut out = vec![text.to_string()];

    // ```json … ``` / ``` … ```
    if let Some(start) = text.find("```") {
        let after = &text[start + 3..];
        let after = after.strip_prefix("json").unwrap_or(after);
        let after = after.trim_start_matches(['\r', '\n']);
        if let Some(end) = after.find("```") {
            out.push(after[..end].trim().to_string());
        } else {
            // 閉じていないフェンス。**残り全部を候補にする**（切れた応答で起きる）。
            out.push(after.trim().to_string());
        }
    }

    // 最初の `{` から最後の `}` まで。
    if let (Some(open), Some(close)) = (text.find('{'), text.rfind('}')) {
        if open < close {
            out.push(text[open..=close].to_string());
        }
    }

    out.dedup();
    out
}

/// モデルが書いた JSON。**欠けていても弾かない**（繕って受ける）。
#[derive(Deserialize)]
struct RawReview {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    findings: Vec<RawFinding>,
}

#[derive(Deserialize)]
struct RawFinding {
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    line: Option<serde_json::Value>,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    message: String,
}

impl RawReview {
    /// **指摘を落とさない。** 足りない欄は埋め、知らない値は寄せる。
    fn into_text(self, fallback_file: &str) -> ReviewText {
        let findings = self
            .findings
            .into_iter()
            .map(|raw| Finding {
                file: raw
                    .file
                    .filter(|it| !it.trim().is_empty())
                    .unwrap_or_else(|| fallback_file.to_string()),
                // `0` は「行が無い」と同じ扱いにする。文字列で来ることもある。
                line: raw.line.and_then(read_line).filter(|line| *line > 0),
                severity: raw.severity.as_deref().map_or(Severity::Info, Severity::parse),
                title: raw.title,
                message: raw.message,
            })
            .collect();
        ReviewText {
            summary: self.summary,
            findings,
            markdown: None,
            fallback_reason: None,
        }
    }
}

/// `42` でも `"42"` でも読む。読めなければ `None`。
fn read_line(value: serde_json::Value) -> Option<u32> {
    match value {
        serde_json::Value::Number(number) => number.as_u64().and_then(|it| u32::try_from(it).ok()),
        serde_json::Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// 実行前の計画を作る（DESIGN.md §10.4）。
pub fn plan(context: &ReviewContext<'_>) -> Result<ReviewPlan, String> {
    let changes = diff::changed_files(
        context.log,
        context.program,
        context.repo,
        context.source.revisions(),
    )?;
    let paths: Vec<String> = changes.iter().map(|it| it.path.clone()).collect();
    let all_skills = skills_for(context.skills, &paths);
    let budget_tokens = budget(context.profile);

    let mut files = Vec::with_capacity(changes.len());
    let mut total = 0u32;
    for change in &changes {
        let planned = plan_one(context, change, budget_tokens)?;
        if planned.skipped.is_none() {
            total = total.saturating_add(planned.tokens_estimate);
        }
        files.push(planned);
    }

    let sendable = files.iter().filter(|it| it.skipped.is_none()).count();
    let blocked = if context.profile.id.is_empty() {
        Some("接続先が選ばれていません。設定で 1 つ選んでください。".to_string())
    } else if all_skills.is_empty() {
        Some(
            "使う観点が 1 つもありません。設定で 1 つ以上を「使う」にしてください。"
                .to_string(),
        )
    } else if changes.is_empty() {
        Some("この 2 点に差分がありません。レビューするものがありません。".to_string())
    } else if sendable == 0 {
        Some(
            "レビューできるファイルがありません。全部外されているか、差分の無いファイルだけです。"
                .to_string(),
        )
    } else {
        None
    };

    Ok(ReviewPlan {
        files,
        skills: planned(&all_skills),
        tokens_estimate: total,
        blocked,
    })
}

/// 1 ファイルの計画。**投げないものにも理由を付ける。**
fn plan_one(
    context: &ReviewContext<'_>,
    change: &FileChange,
    budget_tokens: u32,
) -> Result<PlannedFile, String> {
    let base = PlannedFile {
        path: change.path.clone(),
        old_path: change.old_path.clone(),
        status: change.status,
        tokens_estimate: 0,
        parts: 0,
        skipped: None,
    };

    if change.is_binary() {
        return Ok(PlannedFile {
            skipped: Some("バイナリなので差分を読めません。".to_string()),
            ..base
        });
    }

    let matched = skills_for(context.skills, std::slice::from_ref(&change.path));
    if matched.is_empty() {
        return Ok(PlannedFile {
            skipped: Some(
                "このファイルに当てはまる観点がありません（skill の globs）。".to_string(),
            ),
            ..base
        });
    }

    let file_diff = fetch_diff(context, change)?;
    if file_diff.binary {
        return Ok(PlannedFile {
            skipped: Some("バイナリなので差分を読めません。".to_string()),
            ..base
        });
    }
    let parts = split_hunks(&file_diff.hunks, budget_tokens);
    if parts.is_empty() {
        return Ok(PlannedFile {
            skipped: Some("差分の中身がありません（モードの変更だけなど）。".to_string()),
            ..base
        });
    }

    Ok(PlannedFile {
        tokens_estimate: estimate_tokens(&unified_text(&file_diff.hunks)),
        parts: parts.len(),
        ..base
    })
}

fn fetch_diff(context: &ReviewContext<'_>, change: &FileChange) -> Result<FileDiff, String> {
    diff::file_diff(
        context.log,
        context.program,
        context.repo,
        &DiffTarget {
            revisions: context.source.revisions(),
            path: &change.path,
            old_path: change.old_path.as_deref(),
        },
        &DiffOptions {
            context_lines: context.context_lines,
            // レビューは**空白の変更も見せる**。`-w` で落とすと、
            // インデントだけの変更が「変更が無い」ように見える。
            ignore_whitespace: false,
            encoding: None,
        },
    )
}

/// コミットメッセージを取る。**渡してよいときだけ返す**（DESIGN.md §10.5）。
///
/// 「コミットとその親」と「無関係な 2 点の比較」は
/// [`DiffSource`] の形が同じなので、**実際に親子かどうかを git に聞く**。
fn commit_message(context: &ReviewContext<'_>) -> Option<String> {
    let (sha, parent) = context.source.commit_message_candidate()?;
    if let Some(parent) = parent {
        if !diff::is_parent_of(context.log, context.program, context.repo, parent, sha) {
            return None;
        }
    }
    diff::commit_message(context.log, context.program, context.repo, sha).ok()
}

/// レビューを 1 回走らせる（DESIGN.md §10.7）。
///
/// `include` は実行前パネルで残されたパス。**計画はここで組み直す** —
/// フロントから届いた分割数や見積もりは使わない（古い計画で走らせない）。
pub fn run(
    context: &ReviewContext<'_>,
    include: &[String],
    cancel: &Cancel,
    sink: &dyn ReviewSink,
) -> Result<ReviewRun, String> {
    let started = std::time::Instant::now();
    let started_at = now_ms();
    let budget_tokens = budget(context.profile);

    let changes = diff::changed_files(
        context.log,
        context.program,
        context.repo,
        context.source.revisions(),
    )?;
    let wanted: Vec<FileChange> = changes
        .into_iter()
        .filter(|change| include.contains(&change.path))
        .collect();

    let paths: Vec<String> = wanted.iter().map(|it| it.path.clone()).collect();
    let all_skills = skills_for(context.skills, &paths);
    let message = commit_message(context);

    // **投げる分だけを先に用意する。** 差分の取得は git なので、
    // 並列の中で回すと認証やロックの都合が読みにくくなる。
    let mut jobs: Vec<Job> = Vec::new();
    for change in &wanted {
        let matched = skills_for(context.skills, std::slice::from_ref(&change.path));
        if matched.is_empty() || change.is_binary() {
            continue;
        }
        let file_diff = fetch_diff(context, change)?;
        if file_diff.binary {
            continue;
        }
        let parts = split_hunks(&file_diff.hunks, budget_tokens);
        if parts.is_empty() {
            continue;
        }
        jobs.push(Job {
            change: change.clone(),
            tokens_estimate: estimate_tokens(&unified_text(&file_diff.hunks)),
            parts,
            system: system_prompt(&matched),
        });
    }

    let endpoint = Endpoint {
        profile: context.profile,
        api_key: context.api_key,
    };
    let summary_system = system_prompt(&SkillEntry::active(context.skills));

    sink.report(ReviewEvent::Started { total: jobs.len() });

    let results: Vec<Mutex<Option<ReviewFileResult>>> =
        (0..jobs.len()).map(|_| Mutex::new(None)).collect();
    let next = AtomicUsize::new(0);
    // **`response_format` を咎められたら、以後は最初から付けない。**
    // 全ファイルで同じ 400 を踏み直さないため。
    let json_object = std::sync::atomic::AtomicBool::new(true);

    let workers = usize::from(context.concurrency.clamp(1, 3)).min(jobs.len().max(1));
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if cancel.is_cancelled() {
                    return;
                }
                let index = next.fetch_add(1, Ordering::SeqCst);
                let Some(job) = jobs.get(index) else { return };

                sink.report(ReviewEvent::FileStarted {
                    index,
                    path: job.change.path.clone(),
                });
                let result = review_one(
                    endpoint,
                    job,
                    index,
                    message.as_deref(),
                    &json_object,
                    cancel,
                    sink,
                );
                sink.report(ReviewEvent::FileDone {
                    index,
                    result: Box::new(result.clone()),
                });
                if let Ok(mut slot) = results[index].lock() {
                    *slot = Some(result);
                }
            });
        }
    });

    let files: Vec<ReviewFileResult> = results
        .into_iter()
        .filter_map(|slot| slot.into_inner().ok().flatten())
        .collect();
    let failed = files.iter().filter(|it| it.error.is_some()).count();
    let cancelled = cancel.is_cancelled();

    // **中止したらサマリは作らない。** 途中までの結果から全体を語らせない。
    // **1 件も読めていないときも作らない** — 要約する中身が無いのに 1 往復させない
    // （全ファイルが 400 で落ちる接続先で、無駄に 1 回多く踏みに行くことになる）。
    let nothing_to_summarize = files.iter().all(|file| file.text.is_none());
    let summary = if cancelled || files.is_empty() || nothing_to_summarize {
        None
    } else {
        sink.report(ReviewEvent::SummaryStarted);
        let text = review_summary(
            endpoint,
            &summary_system,
            &files,
            failed,
            budget_tokens,
            &json_object,
            cancel,
            sink,
        );
        sink.report(ReviewEvent::SummaryDone {
            summary: text.clone(),
        });
        text
    };

    Ok(ReviewRun {
        run_id: uuid::Uuid::new_v4().to_string(),
        profile_id: context.profile.id.clone(),
        model: context.profile.model.clone(),
        source: context.source.clone(),
        skills: planned(&all_skills),
        files,
        summary,
        failed,
        cancelled,
        started_at,
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

/// 投げる 1 ファイル分。
struct Job {
    change: FileChange,
    tokens_estimate: u32,
    parts: Vec<Vec<Hunk>>,
    system: String,
}

fn review_one(
    endpoint: Endpoint<'_>,
    job: &Job,
    index: usize,
    message: Option<&str>,
    json_object: &std::sync::atomic::AtomicBool,
    cancel: &Cancel,
    sink: &dyn ReviewSink,
) -> ReviewFileResult {
    let started = std::time::Instant::now();
    let total = job.parts.len();
    let mut merged = ReviewText::default();
    let mut error = None;

    for (part, hunks) in job.parts.iter().enumerate() {
        if cancel.is_cancelled() {
            break;
        }
        let unified = unified_text(hunks);
        let turns = vec![
            ChatTurn::system(job.system.clone()),
            ChatTurn::user(user_prompt(
                &job.change,
                &unified,
                message,
                (total > 1).then_some((part, total)),
            )),
        ];

        match ask(endpoint, &turns, json_object, cancel, &mut |text| {
            sink.report(ReviewEvent::Delta {
                index,
                text: text.to_string(),
            })
        }) {
            Ok(outcome) => {
                let reason = truncation_reason(&outcome);
                let text = parse_review(&outcome.content, &job.change.path, reason);
                merge(&mut merged, text);
            }
            // **最初の失敗を残す。** 分割の 2 回目だけ失敗しても、
            // 1 回目の結果は捨てない。
            Err(failure) => {
                if error.is_none() {
                    error = Some(failure);
                }
            }
        }
    }

    ReviewFileResult {
        path: job.change.path.clone(),
        old_path: job.change.old_path.clone(),
        parts: total,
        text: (!merged.is_empty()).then_some(merged),
        error,
        tokens_estimate: job.tokens_estimate,
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    }
}

#[allow(clippy::too_many_arguments)]
fn review_summary(
    endpoint: Endpoint<'_>,
    system: &str,
    files: &[ReviewFileResult],
    failed: usize,
    budget_tokens: u32,
    json_object: &std::sync::atomic::AtomicBool,
    cancel: &Cancel,
    sink: &dyn ReviewSink,
) -> Option<ReviewText> {
    let turns = vec![
        ChatTurn::system(system.to_string()),
        ChatTurn::user(summary_prompt(files, failed, budget_tokens)),
    ];
    let outcome = ask(endpoint, &turns, json_object, cancel, &mut |text| {
        sink.report(ReviewEvent::SummaryDelta {
            text: text.to_string(),
        })
    })
    .ok()?;
    let reason = truncation_reason(&outcome);
    Some(parse_review(&outcome.content, "", reason))
}

/// 1 往復。**400 の言い分で 1 度だけ投げ直す**（決定 4 と決定 3）。
fn ask(
    endpoint: Endpoint<'_>,
    turns: &[ChatTurn],
    json_object: &std::sync::atomic::AtomicBool,
    cancel: &Cancel,
    on_delta: &mut dyn FnMut(&str),
) -> Result<ChatOutcome, LlmError> {
    let want_json = json_object.load(Ordering::SeqCst);
    let first = client::chat_stream(
        endpoint.profile,
        endpoint.api_key,
        turns,
        want_json,
        cancel,
        on_delta,
    );
    let Err(failure) = first else {
        return first;
    };

    match client::retry_hint(&failure) {
        // **`response_format` を外して 1 度だけ投げ直す。**
        // 以後この実行では最初から付けない（同じ 400 を全ファイルで踏まない）。
        RetryHint::DropResponseFormat if want_json => {
            json_object.store(false, Ordering::SeqCst);
            client::chat_stream(
                endpoint.profile,
                endpoint.api_key,
                turns,
                false,
                cancel,
                on_delta,
            )
        }
        // 分割は呼び出し側の仕事だが、**ここまで来たものは既に分割済み**なので
        // これ以上割れない。理由をそのまま返す。
        _ => Err(failure),
    }
}

/// 途中で切れたときの言い方。切れていなければ `None`。
fn truncation_reason(outcome: &ChatOutcome) -> Option<&'static str> {
    if outcome.cancelled {
        return Some("中止したので、返事は途中までです。");
    }
    if outcome.truncated {
        return Some("返事が途中で切れました。受け取ったところまで出しています。");
    }
    if outcome.finish_reason.as_deref() == Some("length") {
        return Some(
            "返事が長さの上限で切れました。接続先の設定で max tokens を増やすと最後まで返ります。",
        );
    }
    None
}

/// 分割して投げた結果をまとめる。**どれも捨てない。**
fn merge(into: &mut ReviewText, part: ReviewText) {
    if !part.summary.is_empty() {
        if !into.summary.is_empty() {
            into.summary.push('\n');
        }
        into.summary.push_str(&part.summary);
    }
    into.findings.extend(part.findings);
    if let Some(markdown) = part.markdown {
        let slot = into.markdown.get_or_insert_with(String::new);
        if !slot.is_empty() {
            slot.push_str("\n\n");
        }
        slot.push_str(&markdown);
    }
    if into.fallback_reason.is_none() {
        into.fallback_reason = part.fallback_reason;
    }
}

fn now_ms() -> i64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(since) => since.as_millis() as i64,
        Err(error) => -(error.duration().as_millis() as i64),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        estimate_tokens, file_header, json_candidates, parse_review, split_hunks, summary_prompt,
        unified_text, Finding, ReviewFileResult, ReviewText, Severity,
    };
    use crate::encoding::LineEnding;
    use crate::git::diff::{ChangeStatus, DiffLine, DiffLineKind, FileChange, Hunk};

    fn line(kind: DiffLineKind, text: &str) -> DiffLine {
        DiffLine {
            kind,
            old_line: None,
            new_line: None,
            text: text.to_string(),
            ending: Some(LineEnding::Lf),
        }
    }

    fn hunk(old_start: u32, new_start: u32, lines: Vec<DiffLine>) -> Hunk {
        Hunk {
            old_start,
            old_lines: lines.len() as u32,
            new_start,
            new_lines: lines.len() as u32,
            heading: String::new(),
            lines,
        }
    }

    fn change(path: &str, status: ChangeStatus, old_path: Option<&str>) -> FileChange {
        FileChange {
            path: path.to_string(),
            old_path: old_path.map(str::to_string),
            status,
            additions: Some(1),
            deletions: Some(0),
            old_mode: "100644".to_string(),
            new_mode: "100644".to_string(),
        }
    }

    // ---- 見積もり -----------------------------------------------------------

    /// **最短・最長・空を列挙する**（T-20 の申し送り）。
    #[test]
    fn estimates_tokens_from_the_character_count() {
        assert_eq!(estimate_tokens(""), 0, "空は 0");
        // **切り上げる。** 1 文字を 0 トークンにすると、
        // 「予算に収まっている」ように見えるファイルができる。
        assert_eq!(estimate_tokens("a"), 1);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
        // 日本語は 1 文字 1 トークンに近いので、この見積もりは小さく出る。
        // **それを承知で採ってある**（DESIGN.md §10.4）。外したときは
        // 接続先の超過エラーで拾う。
        assert_eq!(estimate_tokens("あいうえお"), 2);
    }

    // ---- unified diff の組み立て --------------------------------------------

    #[test]
    fn builds_a_unified_diff_from_hunks() {
        let hunks = vec![hunk(
            1,
            1,
            vec![
                line(DiffLineKind::Context, "keep"),
                line(DiffLineKind::Removed, "old"),
                line(DiffLineKind::Added, "new"),
            ],
        )];
        assert_eq!(unified_text(&hunks), "@@ -1,3 +1,3 @@\n keep\n-old\n+new\n");
    }

    #[test]
    fn writes_the_hunk_heading_when_git_gave_one() {
        let mut one = hunk(5, 7, vec![line(DiffLineKind::Added, "x")]);
        one.heading = "fn main()".to_string();
        assert_eq!(unified_text(&[one]), "@@ -5,1 +7,1 @@ fn main()\n+x\n");
    }

    #[test]
    fn keeps_multiple_hunks_in_order() {
        let hunks = vec![
            hunk(1, 1, vec![line(DiffLineKind::Added, "first")]),
            hunk(9, 9, vec![line(DiffLineKind::Removed, "second")]),
        ];
        assert_eq!(
            unified_text(&hunks),
            "@@ -1,1 +1,1 @@\n+first\n@@ -9,1 +9,1 @@\n-second\n"
        );
    }

    /// **末尾に改行が無い行は印を添える。** git が出す形をそのまま渡す。
    #[test]
    fn marks_a_line_without_a_trailing_newline() {
        let mut without = line(DiffLineKind::Added, "no newline");
        without.ending = None;
        let text = unified_text(&[hunk(1, 1, vec![without])]);
        assert!(
            text.ends_with("+no newline\n\\ No newline at end of file\n"),
            "{text}"
        );
    }

    /// hunk が 0 個なら本文も空。**投げるものが無い。**
    #[test]
    fn an_empty_hunk_list_makes_an_empty_body() {
        assert_eq!(unified_text(&[]), "");
        assert!(split_hunks(&[], 1_000).is_empty());
    }

    #[test]
    fn writes_a_rename_as_old_to_new() {
        let renamed = change("新.txt", ChangeStatus::Renamed, Some("旧.txt"));
        assert!(
            file_header(&renamed).contains("旧.txt → 新.txt"),
            "{}",
            file_header(&renamed)
        );
        // リネームでないファイルは片方だけ。
        let modified = change("a.txt", ChangeStatus::Modified, None);
        assert!(file_header(&modified).contains("ファイル: a.txt"));
        assert!(!file_header(&modified).contains('→'));
    }

    // ---- 分割 ---------------------------------------------------------------

    #[test]
    fn does_not_split_what_already_fits() {
        let hunks = vec![hunk(1, 1, vec![line(DiffLineKind::Added, "x")])];
        assert_eq!(split_hunks(&hunks, 1_000).len(), 1);
    }

    #[test]
    fn splits_into_parts_that_each_fit() {
        let big: Vec<Hunk> = (0..8)
            .map(|index| {
                hunk(
                    index * 10 + 1,
                    index * 10 + 1,
                    vec![line(DiffLineKind::Added, &"x".repeat(100))],
                )
            })
            .collect();
        // 1 hunk がおよそ 30 トークン。予算 60 なら 2 つずつに割れる。
        let parts = split_hunks(&big, 60);
        assert!(parts.len() >= 4, "分かれること: {}", parts.len());
        assert_eq!(
            parts.iter().map(Vec::len).sum::<usize>(),
            big.len(),
            "hunk を落とさないこと"
        );
    }

    /// **1 つの hunk だけで予算を超えるときは、それ以上割れない。**
    #[test]
    fn keeps_a_single_oversized_hunk_whole() {
        let huge = vec![hunk(
            1,
            1,
            vec![line(DiffLineKind::Added, &"x".repeat(10_000))],
        )];
        let parts = split_hunks(&huge, 10);
        assert_eq!(parts.len(), 1, "割れないものは 1 つのまま投げる");
        assert_eq!(parts[0].len(), 1);
    }

    // ---- JSON の読み取りとフォールバック ------------------------------------

    #[test]
    fn reads_a_plain_json_answer() {
        let text = parse_review(r#"{"summary":"よし","findings":[]}"#, "a.txt", None);
        assert_eq!(text.summary, "よし");
        assert!(text.markdown.is_none());
        assert!(text.fallback_reason.is_none());
    }

    #[test]
    fn strips_a_code_fence_before_reading() {
        for wrapped in [
            "```json\n{\"summary\":\"よし\"}\n```",
            "```\n{\"summary\":\"よし\"}\n```",
            // 閉じていないフェンス（応答が切れたとき）。
            "```json\n{\"summary\":\"よし\"}",
        ] {
            let text = parse_review(wrapped, "a.txt", None);
            assert_eq!(text.summary, "よし", "読めていない: {wrapped}");
        }
    }

    #[test]
    fn ignores_prose_around_the_json() {
        let text = parse_review(
            "了解しました。\n{\"summary\":\"よし\"}\nどうぞ。",
            "a.txt",
            None,
        );
        assert_eq!(text.summary, "よし");
    }

    #[test]
    fn falls_back_to_markdown_when_nothing_parses() {
        let text = parse_review("## 見出し\n\n本文", "a.txt", None);
        assert_eq!(text.markdown.as_deref(), Some("## 見出し\n\n本文"));
        assert!(text.fallback_reason.is_some(), "理由を添えること");
        assert!(text.findings.is_empty());
    }

    /// **空の応答でも枠は残す。** 何も返らなかったことが読めること。
    #[test]
    fn keeps_an_empty_answer_as_an_empty_markdown() {
        for empty in ["", "   ", "\n\n"] {
            let text = parse_review(empty, "a.txt", None);
            assert_eq!(text.markdown.as_deref(), Some(""), "{empty:?}");
            assert!(text.fallback_reason.is_some());
        }
    }

    #[test]
    fn uses_the_given_reason_when_the_answer_was_cut_short() {
        let text = parse_review("{壊れて", "a.txt", Some("途中で切れました"));
        assert_eq!(text.fallback_reason.as_deref(), Some("途中で切れました"));
    }

    /// **指摘を落とさない。** 欄が欠けていても、値を知らなくても受ける。
    #[test]
    fn repairs_a_finding_instead_of_dropping_it() {
        let text = parse_review(
            r#"{"findings":[
                {"title":"欄が足りない"},
                {"file":"","line":0,"severity":"BLOCKER","title":"知らない重さ"},
                {"file":"b.txt","line":"12","severity":"Critical","title":"文字列の行番号"}
            ]}"#,
            "fallback.txt",
            None,
        );
        assert_eq!(text.findings.len(), 3, "1 件も落とさない");
        assert_eq!(text.summary, "", "summary が無くても Markdown へ落とさない");
        assert!(text.markdown.is_none());

        assert_eq!(
            text.findings[0].file, "fallback.txt",
            "file はいま見ているファイル"
        );
        assert_eq!(text.findings[0].line, None);
        assert_eq!(text.findings[0].severity, Severity::Info);

        assert_eq!(text.findings[1].file, "fallback.txt", "空文字も埋める");
        assert_eq!(text.findings[1].line, None, "0 は「行が無い」と同じ");
        assert_eq!(
            text.findings[1].severity,
            Severity::Info,
            "知らない重さは info へ"
        );

        assert_eq!(text.findings[2].line, Some(12), "文字列の行番号も読む");
        assert_eq!(
            text.findings[2].severity,
            Severity::Critical,
            "大文字でも読む"
        );
    }

    #[test]
    fn finds_the_json_in_the_most_likely_order() {
        let candidates = json_candidates("前置き ```json\n{\"a\":1}\n``` 後書き");
        assert_eq!(
            candidates[0], "前置き ```json\n{\"a\":1}\n``` 後書き",
            "素のまま読むのが最初"
        );
        assert!(
            candidates.contains(&"{\"a\":1}".to_string()),
            "{candidates:?}"
        );
    }

    // ---- 全体サマリ ---------------------------------------------------------

    fn result(path: &str, summary: &str) -> ReviewFileResult {
        ReviewFileResult {
            path: path.to_string(),
            old_path: None,
            parts: 1,
            text: Some(ReviewText {
                summary: summary.to_string(),
                findings: vec![Finding {
                    file: path.to_string(),
                    line: None,
                    severity: Severity::Minor,
                    title: format!("{path} の見出し"),
                    message: "本文".to_string(),
                }],
                markdown: None,
                fallback_reason: None,
            }),
            error: None,
            tokens_estimate: 1,
            elapsed_ms: 1,
        }
    }

    #[test]
    fn the_summary_prompt_carries_summaries_and_not_diffs() {
        let files = vec![result("a.txt", "A の要約"), result("b.txt", "B の要約")];
        let prompt = summary_prompt(&files, 0, 10_000);
        assert!(prompt.contains("A の要約") && prompt.contains("B の要約"));
        assert!(prompt.contains("a.txt の見出し"), "指摘の見出しも渡す");
        assert!(!prompt.contains("@@ -"), "差分は渡さない");
        assert!(
            !prompt.contains("件のファイルはレビューに失敗"),
            "失敗 0 件なら書かない"
        );
    }

    #[test]
    fn the_summary_prompt_says_how_many_failed() {
        let prompt = summary_prompt(&[result("a.txt", "要約")], 3, 10_000);
        assert!(
            prompt.contains("3 件のファイルはレビューに失敗しました"),
            "{prompt}"
        );
    }

    /// **予算を超えたら切る。** 切ったことを黙らない。
    #[test]
    fn the_summary_prompt_stops_at_the_budget_and_says_so() {
        let files: Vec<ReviewFileResult> = (0..50)
            .map(|index| result(&format!("file{index}.txt"), &"要約".repeat(100)))
            .collect();
        let prompt = summary_prompt(&files, 0, 200);
        assert!(
            prompt.contains("件は長さの都合で要約に含めていません"),
            "{prompt}"
        );
    }
}
