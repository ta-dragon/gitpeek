//! OpenAI 互換クライアント。
//!
//! ここが守っていること:
//!
//! - **API キーは引数で受け取り、戻り値には決して混ぜない。** 外へ出る文字列は
//!   [`sanitize`] を通す（`redact` ＋ 受け取ったキーそのものの伏せ字化。CLAUDE.md §4）
//! - `Authorization` は**キーが空でないときだけ付ける**（Ollama は認証不要）
//! - base URL は末尾の `/` を落としてから繋ぐ。`http://localhost:11434/v1/` を
//!   貼られても壊れない
//! - **失敗は言い分ける**（401 / 404 / 接続不可 / タイムアウト / JSON でない応答）。
//!   人間向けの 1 行 ＋ 展開で生の応答、という fetch / clone と同じ形（DESIGN.md §3.6）
//! - **ブロッキング。** このコードベースは `spawn_blocking` で揃えてある（`git/exec.rs`）

use std::io::Read;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use ureq::Agent;

use crate::git::exec::Cancel;
use crate::git::fetchprogress::LineSplitter;
use crate::redact::redact;
use crate::store::settings::LlmProfile;

/// 接続の待ち時間。**ローカル Ollama は初回のモデルロードで数十秒かかる**ので、
/// 短くすると「壊れている」ように見える。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);

/// 接続テストで使う `max_tokens`。**プロファイルの値は使わない** — 疎通の確認に
/// 何千トークンも生成させない。
const PROBE_MAX_TOKENS: u32 = 16;

/// ストリーミングで**最初の応答が返るまで**の待ち時間。
///
/// ローカルのモデルは初回のロードで数十秒かかるので、接続テストと同じ 120 秒を取る。
const STREAM_FIRST_TOKEN_TIMEOUT: Duration = Duration::from_secs(120);

/// ストリーミングで**本文を最後まで読み終える**までの待ち時間。
///
/// 既定の `timeout_global`（120 秒）のままだと、**長い生成を途中で切ってしまう**。
/// かといって無制限にすると、黙り込んだサーバから永久に返らない経路ができる。
/// 途中でやめたいときは中止（[`Cancel`]）で畳む。
const STREAM_BODY_TIMEOUT: Duration = Duration::from_secs(600);

/// ストリームから読む 1 回ぶんの大きさ。
const STREAM_CHUNK: usize = 8 * 1024;

/// **流す前に手元へ残しておく文字数**（ホールドバック）。
///
/// チャンクの切れ目で秘匿情報が割れると、チャンクごとにマスクしても素通りする。
/// 末尾をこれだけ残し、次のチャンクと繋がってからマスクして流す。
/// `redact` が見る一番長い形（認証情報付き URL）を丸ごと収められる幅にしてある。
const HOLDBACK_CHARS: usize = 256;

/// 生の応答を画面へ出すときの上限。長い HTML のエラーページを丸ごと抱えない。
const RAW_LIMIT: usize = 4_000;

/// 見出しに載せるサーバ側の説明の長さ。これを超えたら切って、続きは `detail` で読ませる。
const HEADLINE_LIMIT: usize = 200;

/// 失敗の種類。**画面はこれで文言と復旧手順を出し分ける。**
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LlmErrorKind {
    /// 401 / 403。API キーが違う・足りない。
    Unauthorized,
    /// 404。base URL の末尾が `/v1` になっていないことが多い。
    NotFound,
    /// その他の HTTP エラー（400 / 429 / 5xx）。
    Status,
    /// 接続できない。サーバが起動していない・ホスト名が引けない。
    Unreachable,
    /// 時間内に返らなかった。
    Timeout,
    /// 応答が JSON でない、または OpenAI 互換の形ではない。
    BadResponse,
    /// base URL が URL として読めない。
    BadUrl,
    /// 通信の手前で止まった（プロファイルが無い・資格情報が読めない）。
    /// **画面はネットワークの失敗と同じ形で出せる**ので、ここに畳んである。
    Config,
}

/// 失敗の中身。`message` を 1 行で出し、`detail` は展開で見せる。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmError {
    pub kind: LlmErrorKind,
    /// 人間向けの 1 行。**「何をすればいいか」まで書く。**
    pub message: String,
    /// 生の応答。無ければ空文字。**必ずマスク済み。**
    pub detail: String,
}

impl LlmError {
    /// 通信の手前で止まったとき。生の応答は無い。
    pub fn config(message: impl Into<String>) -> Self {
        Self::new(LlmErrorKind::Config, message, String::new())
    }

    fn new(kind: LlmErrorKind, message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            detail: detail.into(),
        }
    }
}

/// 接続テストが通ったときの中身。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestOutcome {
    /// 応答が名乗ったモデル名。名乗らなければ要求したモデル名。
    pub model: String,
    /// 返ってきた本文。空の応答（`max_tokens` で切られた等）もありうる。
    pub reply: String,
    pub elapsed_ms: u64,
    /// 生の応答。**マスク済み。**
    pub raw: String,
}

/// モデル一覧。`/v1/models` を持たないサーバもあるので、失敗しても手入力できること。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelList {
    pub models: Vec<String>,
    pub elapsed_ms: u64,
}

/// `GET {base_url}/models`
pub fn list_models(profile: &LlmProfile, api_key: &str) -> Result<ModelList, LlmError> {
    let url = endpoint(&profile.base_url, "models")?;
    let started = Instant::now();
    let (status, body) = get(&url, api_key)?;
    let body = sanitize(&body, api_key);

    if let Some(error) = http_error(status, &url, &body) {
        return Err(error);
    }

    let parsed: ModelsResponse = serde_json::from_str(&body).map_err(|error| {
        LlmError::new(
            LlmErrorKind::BadResponse,
            format!(
                "モデル一覧が OpenAI 互換の形で返りませんでした（{error}）。\
                 モデル名は手で入力できます。"
            ),
            truncate(&body),
        )
    })?;

    let mut models: Vec<String> = parsed
        .data
        .into_iter()
        .map(|model| model.id)
        .filter(|id| !id.is_empty())
        .collect();
    models.sort();
    models.dedup();

    Ok(ModelList {
        models,
        elapsed_ms: elapsed_ms(started),
    })
}

/// `POST {base_url}/chat/completions` に 1 往復させる。
///
/// **`/v1/models` だけで済ませない。** Ollama は認証不要なので models が通っても
/// 生成まで通るとは限らない。応答が返ることまで見る。
pub fn test_connection(profile: &LlmProfile, api_key: &str) -> Result<TestOutcome, LlmError> {
    let url = endpoint(&profile.base_url, "chat/completions")?;
    let request = ChatRequest {
        model: &profile.model,
        messages: vec![ChatMessage {
            role: "user",
            content: "ping",
        }],
        // プロファイルの値をそのまま使う。**範囲外の値はここで露見したほうがよい。**
        temperature: profile.temperature,
        max_tokens: PROBE_MAX_TOKENS,
        stream: false,
        // 疎通の確認に形式の縛りは要らない。**接続テストは今まで通り。**
        response_format: None,
    };
    let payload = serde_json::to_string(&request).expect("固定の構造体なので失敗しない");

    let started = Instant::now();
    let (status, body) = post(&url, api_key, &payload)?;
    let body = sanitize(&body, api_key);

    if let Some(error) = http_error(status, &url, &body) {
        return Err(error);
    }

    let parsed: ChatResponse = serde_json::from_str(&body).map_err(|error| {
        LlmError::new(
            LlmErrorKind::BadResponse,
            format!(
                "応答が OpenAI 互換の形ではありません（{error}）。\
                 base URL が OpenAI 互換の入口（末尾が /v1）を指しているか確かめてください。"
            ),
            truncate(&body),
        )
    })?;

    let Some(choice) = parsed.choices.first() else {
        return Err(LlmError::new(
            LlmErrorKind::BadResponse,
            "応答に choices がありません。モデル名が正しいか確かめてください。",
            truncate(&body),
        ));
    };

    Ok(TestOutcome {
        model: if parsed.model.is_empty() {
            profile.model.clone()
        } else {
            parsed.model
        },
        reply: choice.message.content.clone(),
        elapsed_ms: elapsed_ms(started),
        raw: truncate(&body),
    })
}

/// やりとり 1 往復ぶんの中身。**組み立てるのは呼び出し側**（`llm/review.rs`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatTurn {
    /// `"system"` か `"user"`。
    pub role: &'static str,
    pub content: String,
}

impl ChatTurn {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system",
            content: content.into(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user",
            content: content.into(),
        }
    }
}

/// ストリーミングで 1 往復した結果。**すべてマスク済み。**
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ChatOutcome {
    /// 本文の全文。**流した差分をすべて繋いだものと一致する。**
    pub content: String,
    /// 生の応答（SSE の行そのまま）。切り詰め済み。
    pub raw: String,
    /// 中止で打ち切った。**ここまでの `content` は残っている。**
    pub cancelled: bool,
    /// 最後まで読み切れなかった。フォールバックの理由に使う。
    pub truncated: bool,
    /// サーバが言った終わり方（`stop` / `length` など）。言わなければ `None`。
    pub finish_reason: Option<String>,
    pub elapsed_ms: u64,
}

/// 400 が返ったとき、**何を変えれば通るか**の見立て。
///
/// 判定をここへ置くのは、[`server_message`] の解釈を外へ持ち出さないため。
/// `llm/review.rs` は種類で分岐するだけでよい。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryHint {
    /// `response_format` を咎めている。外して投げ直せば通る見込み。
    DropResponseFormat,
    /// 文脈長・トークン数を咎めている。分割して投げ直せば通る見込み。
    SplitInput,
    /// 見立てが立たない。**投げ直さない。**
    None,
}

/// 失敗から [`RetryHint`] を読む。**見立てが立たないときは投げ直さない。**
///
/// 同じ要求を闇雲に繰り返すと、落ちる接続先で待ち時間だけが倍になる。
pub fn retry_hint(error: &LlmError) -> RetryHint {
    // 通信そのものが失敗したものは投げ直しても同じ。
    if !matches!(error.kind, LlmErrorKind::Status) {
        return RetryHint::None;
    }
    // 見出しには「接続先の言い分」が入っている。生の応答も一緒に見る。
    let said = format!("{} {}", error.message, error.detail).to_ascii_lowercase();

    // **`response_format` を先に見る。** 「json_object は未対応」と
    // 「文脈長が足りない」が同時に書かれることは無いが、順序は決めておく。
    if said.contains("response_format") || said.contains("response format") {
        return RetryHint::DropResponseFormat;
    }
    if said.contains("context length")
        || said.contains("context_length")
        || said.contains("context window")
        || said.contains("maximum context")
        || said.contains("too many tokens")
        || said.contains("too long")
        || said.contains("num_ctx")
    {
        return RetryHint::SplitInput;
    }
    RetryHint::None
}

/// `POST {base_url}/chat/completions` をストリーミングで 1 往復させる。
///
/// - `on_delta` には**マスク済みの差分**が届く。繋ぐと [`ChatOutcome::content`] になる
/// - `json_object` が立っていれば `response_format` を付ける。
///   **咎められたら呼び出し側が外して投げ直す**（[`retry_hint`]）
/// - 中止は**チャンクごと**に見る。読んでいる最中に立った合図は、次のチャンクで効く
///
/// **`stream` を無視して普通の JSON を返すサーバがある。** SSE として 1 件も
/// 読めなかったときは、本文を chat completion として読み直す。
pub fn chat_stream(
    profile: &LlmProfile,
    api_key: &str,
    turns: &[ChatTurn],
    json_object: bool,
    cancel: &Cancel,
    on_delta: &mut dyn FnMut(&str),
) -> Result<ChatOutcome, LlmError> {
    let url = endpoint(&profile.base_url, "chat/completions")?;
    let request = ChatRequest {
        model: &profile.model,
        messages: turns
            .iter()
            .map(|turn| ChatMessage {
                role: turn.role,
                content: &turn.content,
            })
            .collect(),
        temperature: profile.temperature,
        max_tokens: profile.max_tokens,
        stream: true,
        response_format: json_object.then(ResponseFormat::json_object),
    };
    let payload = serde_json::to_string(&request).expect("固定の構造体なので失敗しない");

    let started = Instant::now();
    let mut response = send(streaming_agent(), &url, api_key, &payload)?;
    let status = response.status().as_u16();

    if !(200..300).contains(&status) {
        // 失敗の本文は最後まで読んでよい（短い）。**読めなくても状態から言い分ける。**
        let body = response.body_mut().read_to_string().unwrap_or_default();
        let body = sanitize(&body, api_key);
        if let Some(error) = http_error(status, &url, &body) {
            return Err(error);
        }
    }

    let mut masker = Masker::new(api_key);
    let mut splitter = LineSplitter::new();
    let mut raw = String::new();
    let mut outcome = ChatOutcome::default();
    let mut saw_sse = false;
    let mut buffer = vec![0u8; STREAM_CHUNK];
    let mut reader = response.body_mut().as_reader();

    loop {
        if cancel.is_cancelled() {
            outcome.cancelled = true;
            break;
        }
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) => {
                // **ここまでを捨てない。** 途中で切れたものとして返し、
                // 構造化できなければ呼び出し側が Markdown へ落とす。
                if raw.is_empty() {
                    return Err(LlmError::new(
                        LlmErrorKind::BadResponse,
                        "応答を最後まで読み取れませんでした。もう一度試してください。",
                        sanitize(&error.to_string(), api_key),
                    ));
                }
                outcome.truncated = true;
                break;
            }
        };

        for line in splitter.push(&buffer[..read]) {
            raw.push_str(&line);
            raw.push('\n');
            match parse_sse_line(&line) {
                SseLine::Delta {
                    content,
                    finish_reason,
                } => {
                    saw_sse = true;
                    if let Some(reason) = finish_reason {
                        outcome.finish_reason = Some(reason);
                    }
                    if !content.is_empty() {
                        let masked = masker.push(&content);
                        if !masked.is_empty() {
                            on_delta(&masked);
                        }
                    }
                }
                SseLine::Done => {
                    saw_sse = true;
                    outcome.finish_reason.get_or_insert_with(|| "stop".to_string());
                }
                SseLine::Ignore => {}
            }
        }
    }

    if let Some(line) = splitter.flush() {
        raw.push_str(&line);
        if let SseLine::Delta { content, .. } = parse_sse_line(&line) {
            saw_sse = true;
            let masked = masker.push(&content);
            if !masked.is_empty() {
                on_delta(&masked);
            }
        }
    }

    // **`stream` を無視して普通の JSON を返すサーバ**の受け皿。
    // SSE として 1 件も読めなかったときだけ、本文を chat completion として読み直す。
    if !saw_sse && !outcome.cancelled {
        if let Some(content) = whole_body_content(&raw) {
            let masked = masker.push(&content);
            if !masked.is_empty() {
                on_delta(&masked);
            }
        }
    }

    let (rest, content) = masker.finish();
    if !rest.is_empty() {
        on_delta(&rest);
    }

    // `[DONE]` も `finish_reason` も無いまま終わったら、途中で切れた疑いがある。
    if outcome.finish_reason.is_none() && !outcome.cancelled {
        outcome.truncated = true;
    }
    outcome.content = content;
    outcome.raw = truncate(&sanitize(&raw, api_key));
    outcome.elapsed_ms = elapsed_ms(started);
    Ok(outcome)
}

/// SSE の 1 行から読めたもの。
#[derive(Debug, Clone, PartialEq, Eq)]
enum SseLine {
    Delta {
        content: String,
        finish_reason: Option<String>,
    },
    Done,
    /// 空行・コメント（`: ping`）・`data:` でない行・JSON でない `data:` 行。
    /// **捨てるが、生の応答としては残す**（呼び出し側が `raw` に積む）。
    Ignore,
}

/// SSE の 1 行を読む。
///
/// 行の切り出しは [`LineSplitter`] に任せてある（`\r` でも `\n` でも切れる）。
fn parse_sse_line(line: &str) -> SseLine {
    let line = line.trim_end_matches(['\r', '\n']);
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return SseLine::Ignore;
    }
    // コメント（keepalive）。
    if trimmed.starts_with(':') {
        return SseLine::Ignore;
    }
    let Some(payload) = trimmed.strip_prefix("data:") else {
        return SseLine::Ignore;
    };
    let payload = payload.trim();
    if payload == "[DONE]" {
        return SseLine::Done;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
        // JSON でない `data:` 行。**捨てる**（生の応答には残っている）。
        return SseLine::Ignore;
    };

    let choice = value.get("choices").and_then(|it| it.get(0));
    let content = choice
        .and_then(|it| it.get("delta"))
        .and_then(|it| it.get("content"))
        // `delta` を持たない実装もある（非ストリーミングの形をそのまま流す）。
        .or_else(|| choice.and_then(|it| it.get("message")).and_then(|it| it.get("content")))
        .and_then(|it| it.as_str())
        .unwrap_or_default()
        .to_string();
    let finish_reason = choice
        .and_then(|it| it.get("finish_reason"))
        .and_then(|it| it.as_str())
        .map(|it| it.to_string());

    SseLine::Delta {
        content,
        finish_reason,
    }
}

/// SSE ではない本文から中身を取り出す。読めなければ `None`。
fn whole_body_content(raw: &str) -> Option<String> {
    let parsed: ChatResponse = serde_json::from_str(raw.trim()).ok()?;
    let content = parsed.choices.first()?.message.content.clone();
    if content.is_empty() {
        return None;
    }
    Some(content)
}

/// 流す前にマスクする。**末尾を手元に残してから流す。**
///
/// チャンクの切れ目で秘匿情報が割れると、チャンクごとに [`sanitize`] を掛けても
/// 素通りする（T-20 で踏んだ「1 文字のキー」と同じ種類の穴）。
///
/// 溜めた全文にマスクを掛け直し、**末尾 [`HOLDBACK_CHARS`] 文字を除いた分**だけ流す。
/// マスクで縮むのは必ず末尾側（＝まだ流していない範囲）なので、流した分は動かない。
struct Masker<'a> {
    api_key: &'a str,
    /// 受け取った生の全文。マスク前。
    raw: String,
    /// すでに流した文字数（マスク後の数え方）。
    emitted: usize,
}

impl<'a> Masker<'a> {
    fn new(api_key: &'a str) -> Self {
        Self {
            api_key,
            raw: String::new(),
            emitted: 0,
        }
    }

    /// 差分を足し、**流してよい分**を返す。まだ流せなければ空文字。
    fn push(&mut self, text: &str) -> String {
        self.raw.push_str(text);
        let masked: Vec<char> = sanitize(&self.raw, self.api_key).chars().collect();
        if masked.len() <= HOLDBACK_CHARS {
            return String::new();
        }
        let upto = masked.len() - HOLDBACK_CHARS;
        if upto <= self.emitted {
            return String::new();
        }
        let out: String = masked[self.emitted..upto].iter().collect();
        self.emitted = upto;
        out
    }

    /// 読み終わったあとの残りと、マスク済みの全文。
    fn finish(&mut self) -> (String, String) {
        let full = sanitize(&self.raw, self.api_key);
        let masked: Vec<char> = full.chars().collect();
        let from = self.emitted.min(masked.len());
        let rest: String = masked[from..].iter().collect();
        self.emitted = masked.len();
        (rest, full)
    }
}

/// `{base_url}` の末尾スラッシュを落として `path` を繋ぐ。
///
/// **末尾の `/` の有無で URL が変わらないこと**が要件（`.../v1/` を貼られても壊れない）。
pub fn endpoint(base_url: &str, path: &str) -> Result<String, LlmError> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(LlmError::new(
            LlmErrorKind::BadUrl,
            "接続先の URL が空です。`http://localhost:11434/v1` のように入力してください。",
            String::new(),
        ));
    }
    let lower = base.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err(LlmError::new(
            LlmErrorKind::BadUrl,
            format!("接続先の URL は http:// か https:// で始まる必要があります: {base}"),
            String::new(),
        ));
    }
    Ok(format!("{base}/{path}"))
}

/// タイムアウトを固定した agent。**すべての呼び出しがこれを通る。**
fn agent() -> Agent {
    Agent::config_builder()
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_global(Some(RESPONSE_TIMEOUT))
        // 4xx / 5xx を Err にしない。**本文を読んで理由を出したい。**
        .http_status_as_error(false)
        .build()
        .into()
}

/// ストリーミング用の agent。**待ち時間の立て方が違う。**
///
/// 全体（`timeout_global`）で縛ると、長い生成を途中で切ってしまう。
/// 「最初の応答まで」と「本文を読み終えるまで」を別に持つ。
fn streaming_agent() -> Agent {
    Agent::config_builder()
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_recv_response(Some(STREAM_FIRST_TOKEN_TIMEOUT))
        .timeout_recv_body(Some(STREAM_BODY_TIMEOUT))
        .http_status_as_error(false)
        .build()
        .into()
}

/// 応答を**読まずに**返す。ストリーミングは本文を少しずつ読むので、
/// [`read`] のように読み切ってしまってはいけない。
fn send(
    agent: Agent,
    url: &str,
    api_key: &str,
    payload: &str,
) -> Result<ureq::http::Response<ureq::Body>, LlmError> {
    let mut request = agent
        .post(url)
        .header("Content-Type", "application/json")
        // SSE を受ける。**受け付けないサーバでも普通の JSON が返るだけ**で、
        // その場合は `whole_body_content` が拾う。
        .header("Accept", "text/event-stream");
    if !api_key.is_empty() {
        request = request.header("Authorization", format!("Bearer {api_key}"));
    }
    request
        .send(payload)
        .map_err(|error| transport_error(&error, url, api_key))
}

fn get(url: &str, api_key: &str) -> Result<(u16, String), LlmError> {
    let mut request = agent().get(url).header("Accept", "application/json");
    // **キーが空のときは付けない**（Ollama は認証不要で、空の Bearer を嫌うものがある）。
    if !api_key.is_empty() {
        request = request.header("Authorization", format!("Bearer {api_key}"));
    }
    read(request.call(), url, api_key)
}

fn post(url: &str, api_key: &str, payload: &str) -> Result<(u16, String), LlmError> {
    let mut request = agent()
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json");
    if !api_key.is_empty() {
        request = request.header("Authorization", format!("Bearer {api_key}"));
    }
    read(request.send(payload), url, api_key)
}

fn read(
    result: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    url: &str,
    api_key: &str,
) -> Result<(u16, String), LlmError> {
    let mut response = result.map_err(|error| transport_error(&error, url, api_key))?;
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_string().map_err(|error| {
        LlmError::new(
            LlmErrorKind::BadResponse,
            "応答を最後まで読み取れませんでした。もう一度試してください。",
            sanitize(&error.to_string(), api_key),
        )
    })?;
    Ok((status, body))
}

/// 繋がらなかった側の失敗。**接続不可とタイムアウトを言い分ける。**
fn transport_error(error: &ureq::Error, url: &str, api_key: &str) -> LlmError {
    let detail = sanitize(&error.to_string(), api_key);
    let url = sanitize(url, api_key);
    match error {
        ureq::Error::Timeout(_) => LlmError::new(
            LlmErrorKind::Timeout,
            format!(
                "{}秒待っても応答がありませんでした。ローカルのモデルは初回の読み込みに\
                 時間がかかることがあります。もう一度試してください。",
                RESPONSE_TIMEOUT.as_secs()
            ),
            detail,
        ),
        ureq::Error::BadUri(_) => LlmError::new(
            LlmErrorKind::BadUrl,
            format!("接続先の URL を解釈できません: {url}"),
            detail,
        ),
        _ => LlmError::new(
            LlmErrorKind::Unreachable,
            format!(
                "{url} へ接続できませんでした。サーバが起動しているか、URL とポートが\
                 合っているかを確かめてください。"
            ),
            detail,
        ),
    }
}

/// HTTP のステータスから失敗を作る。成功なら `None`。
///
/// **サーバ自身が言っている理由を見出しへ引き上げる。** ステータスだけでは
/// 「モデル名が違う」と「文脈長を超えた」がどちらも「HTTP 400」になり、
/// 生の応答を開かないと原因が読めない（利用者の指摘。2026-09-05）。
fn http_error(status: u16, url: &str, body: &str) -> Option<LlmError> {
    if (200..300).contains(&status) {
        return None;
    }
    let detail = truncate(body);
    // **`body` は `sanitize` 済みで渡ってくる。** ここで初めて外へ出す文字列を
    // 作るわけではないので、キーが混ざる余地は無い。
    let said = server_message(body);
    let with_reason = |headline: String| match &said {
        Some(reason) => format!("{headline}
接続先の言い分: {reason}"),
        None => headline,
    };

    Some(match status {
        401 | 403 => LlmError::new(
            LlmErrorKind::Unauthorized,
            with_reason(format!(
                "API キーが受け付けられませんでした（HTTP {status}）。キーを入力し直してください。"
            )),
            detail,
        ),
        404 => LlmError::new(
            LlmErrorKind::NotFound,
            with_reason(format!(
                "接続先が見つかりません（HTTP 404）。{url} が正しいか、base URL の末尾が /v1 になっているかを確かめてください。"
            )),
            detail,
        ),
        429 => LlmError::new(
            LlmErrorKind::Status,
            with_reason(
                "要求が多すぎると断られました（HTTP 429）。少し待ってから試してください。".to_string(),
            ),
            detail,
        ),
        _ => LlmError::new(
            LlmErrorKind::Status,
            with_reason(format!("接続先がエラーを返しました（HTTP {status}）。")),
            detail,
        ),
    })
}

/// エラー本文からサーバ自身の説明を 1 行取り出す。読めなければ `None`。
///
/// OpenAI 互換を名乗るサーバでも形が揃っていないので、**よくある 4 つを順に見る**。
/// どれでもなければ諦める（生の応答は `detail` に残っている）。
///
/// - `{"error":{"message":"…"}}` … OpenAI / vLLM / LM Studio
/// - `{"error":"…"}`             … Ollama
/// - `{"message":"…"}`           … 前段のプロキシ
/// - `{"detail":"…"}`            … FastAPI 系（unsloth / text-generation-webui など）
fn server_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let said = value
        .get("error")
        // `error` が入れ物なら中の `message`、そうでなければ `error` 自身が説明。
        // **入れ物をそのまま文字列化しない** — 空の `{"error":{}}` が「{}」になる。
        .and_then(|error| match error {
            serde_json::Value::Object(_) => error.get("message"),
            other => Some(other),
        })
        .or_else(|| value.get("message"))
        .or_else(|| value.get("detail"))?;

    let text = match said {
        serde_json::Value::String(text) => text.clone(),
        // 値が無いのと同じ。
        serde_json::Value::Null => return None,
        // 文字列でなければ、そのままの形を見せたほうが原因に近い。
        other => other.to_string(),
    };
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    // 見出しは 1 行。**改行を潰す** — 数十行のスタックトレースを見出しに入れない。
    let single = text.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(truncate_headline(&single))
}

fn truncate_headline(text: &str) -> String {
    if text.chars().count() <= HEADLINE_LIMIT {
        return text.to_string();
    }
    let head: String = text.chars().take(HEADLINE_LIMIT).collect();
    format!("{head}…")
}

/// 外へ出す文字列のマスク。
///
/// `redact` の規則に加えて、**いま使ったキーそのもの**を伏せる。規則に当たらない形の
/// キー（自前サーバの任意文字列など）でも、結果に現れないことをこれで担保する。
fn sanitize(text: &str, api_key: &str) -> String {
    mask_key(&redact(text), api_key)
}

/// キーそのものを伏せる。**英数字の途中では置き換えない。**
///
/// 素の `replace` にしていたら、**1 文字のキー（`a`）で応答が壊れた**
/// （2026-09-05 の目視。`message` が `mess***ge` になり、JSON のキー名まで潰れて
/// `server_message` が理由を取り出せなくなった）。
///
/// キーが**独立した語として現れたときだけ**伏せる。伏せたいのは
/// `Bearer <key>` や `"api_key": "<key>"` のように区切りに挟まれた形であり、
/// 単語の一部として偶然一致したものではない。前後が ASCII 英数字なら別の語の一部と見なす。
/// **`_` や `-` は区切り扱いのまま**にしてある（`prefix_<key>` は伏せたい）。
fn mask_key(text: &str, api_key: &str) -> String {
    if api_key.is_empty() {
        return text.to_string();
    }

    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for (at, _) in text.match_indices(api_key) {
        // 直前に伏せた範囲と重なる出現は飛ばす。
        if at < cursor {
            continue;
        }
        // **境界は必ず元の文字列で見る。** 書き出し済みの文字列で見ると、
        // 直前に伏せ字を入れたせいで前の文字が変わってしまう。
        let before = text[..at].chars().next_back();
        let end = at + api_key.len();
        let after = text[end..].chars().next();
        if before.is_some_and(|c| c.is_ascii_alphanumeric())
            || after.is_some_and(|c| c.is_ascii_alphanumeric())
        {
            continue;
        }
        out.push_str(&text[cursor..at]);
        out.push_str("***");
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    out
}

fn truncate(text: &str) -> String {
    if text.chars().count() <= RAW_LIMIT {
        return text.to_string();
    }
    let head: String = text.chars().take(RAW_LIMIT).collect();
    format!("{head}…（以降は省略）")
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    temperature: f32,
    max_tokens: u32,
    stream: bool,
    /// **付けないときは項目ごと出さない。** `null` を送ると、素直に読む
    /// サーバが「知らない値」として弾く。
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ResponseFormat>,
}

/// `{"type":"json_object"}`。**Ollama は OpenAI 互換層でこれを `format: "json"` に
/// 読み替える**ので、本命のローカル小型モデルにこそ効く（DESIGN.md §10.6）。
#[derive(Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    kind: &'static str,
}

impl ResponseFormat {
    fn json_object() -> Self {
        Self {
            kind: "json_object",
        }
    }
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct ChatResponse {
    #[serde(default)]
    model: String,
    #[serde(default)]
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    #[serde(default)]
    message: ChatContent,
}

#[derive(Default, Deserialize)]
struct ChatContent {
    #[serde(default)]
    content: String,
}

#[derive(Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    #[serde(default)]
    id: String,
}

#[cfg(test)]
mod tests {
    use super::{
        endpoint, http_error, sanitize, server_message, truncate, LlmErrorKind, HEADLINE_LIMIT,
        RAW_LIMIT,
    };

    #[test]
    fn a_trailing_slash_does_not_change_the_url() {
        let with = endpoint("http://localhost:11434/v1/", "models").unwrap();
        let without = endpoint("http://localhost:11434/v1", "models").unwrap();
        assert_eq!(with, without);
        assert_eq!(with, "http://localhost:11434/v1/models");
        // 連続したスラッシュでも増えない。
        assert_eq!(
            endpoint("http://localhost:11434/v1///", "chat/completions").unwrap(),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[test]
    fn rejects_urls_that_are_not_http() {
        for base in ["", "   ", "localhost:11434/v1", "ftp://example.com/v1"] {
            let error = endpoint(base, "models").unwrap_err();
            assert_eq!(error.kind, LlmErrorKind::BadUrl, "{base}");
            assert!(!error.message.is_empty());
        }
    }

    /// **サーバ自身の説明を見出しへ引き上げる。** 形が揃っていないので複数見る。
    #[test]
    fn lifts_the_reason_the_server_gave() {
        let cases = [
            // OpenAI / vLLM / LM Studio
            (
                r#"{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}"#,
                "Incorrect API key provided",
            ),
            // Ollama
            (r#"{"error":"model 'nope' not found"}"#, "model 'nope' not found"),
            // 前段のプロキシ
            (r#"{"message":"upstream timed out"}"#, "upstream timed out"),
            // FastAPI 系（unsloth など）
            (r#"{"detail":"Field required"}"#, "Field required"),
        ];
        for (body, expected) in cases {
            assert_eq!(server_message(body).as_deref(), Some(expected), "{body}");
            let error = http_error(400, "u", body).expect("400 は失敗");
            assert!(error.message.contains(expected), "{}", error.message);
        }
    }

    /// 読めない形なら**黙って諦める**。生の応答は `detail` に残っている。
    #[test]
    fn says_nothing_extra_when_the_body_is_not_readable() {
        for body in ["", "<html>502</html>", "{}", r#"{"error":{}}"#, r#"{"detail":"   "}"#] {
            assert_eq!(server_message(body), None, "{body}");
        }
        let error = http_error(500, "u", "<html>502</html>").unwrap();
        assert!(!error.message.contains("言い分"), "{}", error.message);
    }

    /// **見出しは 1 行。** 数十行のスタックトレースを見出しに入れない。
    #[test]
    fn keeps_the_headline_to_one_line() {
        let body = serde_json::json!({ "detail": "line one
line two
  line three" }).to_string();
        assert_eq!(
            server_message(&body).as_deref(),
            Some("line one line two line three")
        );

        let long = serde_json::json!({ "detail": "あ".repeat(HEADLINE_LIMIT + 50) }).to_string();
        let said = server_message(&long).expect("読めること");
        assert_eq!(said.chars().count(), HEADLINE_LIMIT + 1, "末尾は … の 1 文字");
        assert!(said.ends_with('…'));
    }

    #[test]
    fn tells_the_failures_apart() {
        assert_eq!(http_error(200, "u", ""), None);
        assert_eq!(http_error(204, "u", ""), None);
        assert_eq!(
            http_error(401, "u", "").unwrap().kind,
            LlmErrorKind::Unauthorized
        );
        assert_eq!(
            http_error(403, "u", "").unwrap().kind,
            LlmErrorKind::Unauthorized
        );
        assert_eq!(http_error(404, "u", "").unwrap().kind, LlmErrorKind::NotFound);
        assert_eq!(http_error(429, "u", "").unwrap().kind, LlmErrorKind::Status);
        assert_eq!(http_error(500, "u", "").unwrap().kind, LlmErrorKind::Status);
    }

    /// **規則に当たらない形のキーでも結果に現れない。**
    #[test]
    fn masks_the_key_even_when_it_looks_like_nothing() {
        let key = "totally-ordinary-looking-value";
        let masked = sanitize(&format!("bad token: {key} rejected"), key);
        assert_eq!(masked, "bad token: *** rejected");
        assert!(!masked.contains(key));
    }

    /// **単語の途中では伏せない。**
    ///
    /// 素の `replace` だったころ、キーが `a` の 1 文字だと 401 の本文が
    /// `{"error":{"mess***ge":"Inv***lid token p***ylo***d"}}` になり、
    /// JSON のキー名まで潰れて理由が取り出せなくなった（2026-09-05 の目視）。
    #[test]
    fn a_one_letter_key_does_not_shred_the_body() {
        let body = r#"{"error":{"message":"Invalid token payload","type":"authentication_error"}}"#;
        assert_eq!(sanitize(body, "a"), body, "本文が壊れてはいけない");

        // 理由がそのまま取り出せること（これが壊れると見出しから消える）。
        let error = http_error(401, "u", &sanitize(body, "a")).expect("401 は失敗");
        assert!(
            error.message.contains("Invalid token payload"),
            "{}",
            error.message
        );
    }

    /// 短いキーでも、**独立した語として出てきたら伏せる。**
    #[test]
    fn masks_a_short_key_when_it_stands_alone() {
        assert_eq!(sanitize(r#"{"token":"a"}"#, "a"), r#"{"token":"***"}"#);
        assert_eq!(sanitize("Bearer a rejected", "a"), "Bearer *** rejected");
        // 区切り文字は境界。`prefix_<key>` は伏せたい。
        assert_eq!(sanitize("prefix_a", "a"), "prefix_***");
        assert_eq!(sanitize("a-b", "a"), "***-b");
    }

    /// 複数回出ても、重なっても壊れない。
    #[test]
    fn masks_every_standalone_occurrence() {
        let key = "sk-secret";
        assert_eq!(
            sanitize(&format!("{key} and {key} but not {key}extra"), key),
            "*** and *** but not sk-secretextra",
            "英数字が続く 3 つ目は別の語",
        );
        // 隣り合う出現。境界を元の文字列で見ていないとここで崩れる。
        assert_eq!(sanitize("xx xx", "xx"), "*** ***");
        assert_eq!(sanitize("xxxx", "xx"), "xxxx", "続いていれば 1 つの語");
    }

    #[test]
    fn masks_by_the_shared_rules_too() {
        let masked = sanitize("Authorization: Bearer sk-abcdefghijklmnopqrstuvwx", "");
        assert!(!masked.contains("abcdefghij"), "{masked}");
    }

    #[test]
    fn truncates_long_bodies_without_panicking_on_multibyte() {
        let long = "あ".repeat(RAW_LIMIT + 100);
        let cut = truncate(&long);
        assert!(cut.ends_with("…（以降は省略）"));
        assert_eq!(cut.chars().count(), RAW_LIMIT + "…（以降は省略）".chars().count());
        assert_eq!(truncate("短い"), "短い");
    }

    // ---- SSE のパース（T-22）------------------------------------------------

    use super::{
        parse_sse_line, retry_hint, whole_body_content, Masker, RetryHint, SseLine,
        HOLDBACK_CHARS,
    };

    fn delta_of(line: &str) -> Option<String> {
        match parse_sse_line(line) {
            SseLine::Delta { content, .. } => Some(content),
            _ => None,
        }
    }

    #[test]
    fn reads_the_content_out_of_a_data_line() {
        assert_eq!(
            delta_of(r#"data: {"choices":[{"delta":{"content":"あ"}}]}"#).as_deref(),
            Some("あ")
        );
        // `data:` の後ろに空白が無い形も受ける。
        assert_eq!(
            delta_of(r#"data:{"choices":[{"delta":{"content":"い"}}]}"#).as_deref(),
            Some("い")
        );
    }

    #[test]
    fn reads_a_done_line() {
        assert_eq!(parse_sse_line("data: [DONE]"), SseLine::Done);
        assert_eq!(parse_sse_line("data:[DONE]"), SseLine::Done);
    }

    /// **捨てる行**。空行・keepalive・`data:` でない行・JSON でない `data:` 行。
    #[test]
    fn ignores_the_lines_that_carry_nothing() {
        for line in [
            "",
            "   ",
            ": ping",
            ":",
            "event: message",
            "id: 42",
            "data: これは JSON ではない",
            "data: {壊れている",
        ] {
            assert_eq!(parse_sse_line(line), SseLine::Ignore, "{line:?}");
        }
    }

    /// CRLF で来ても同じ。
    #[test]
    fn reads_a_data_line_that_ends_with_crlf() {
        assert_eq!(
            delta_of("data: {\"choices\":[{\"delta\":{\"content\":\"う\"}}]}\r\n").as_deref(),
            Some("う")
        );
    }

    /// `delta` を持たず `message` で寄越す実装もある。
    #[test]
    fn reads_a_line_that_uses_message_instead_of_delta() {
        assert_eq!(
            delta_of(r#"data: {"choices":[{"message":{"content":"え"}}]}"#).as_deref(),
            Some("え")
        );
    }

    #[test]
    fn reads_the_finish_reason() {
        let SseLine::Delta { finish_reason, .. } =
            parse_sse_line(r#"data: {"choices":[{"delta":{},"finish_reason":"length"}]}"#)
        else {
            panic!("Delta として読めていない");
        };
        assert_eq!(finish_reason.as_deref(), Some("length"));
    }

    /// **中身の無い `data:` 行**（`choices` が空、`delta` が空）でも落ちない。
    #[test]
    fn survives_a_data_line_with_no_content() {
        assert_eq!(delta_of(r#"data: {"choices":[]}"#).as_deref(), Some(""));
        assert_eq!(delta_of(r#"data: {}"#).as_deref(), Some(""));
        assert_eq!(
            delta_of(r#"data: {"choices":[{"delta":{}}]}"#).as_deref(),
            Some("")
        );
    }

    /// **`stream` を無視して普通の JSON を返すサーバ**の受け皿。
    #[test]
    fn reads_a_whole_chat_completion_body() {
        let body = r#"{"model":"m","choices":[{"message":{"role":"assistant","content":"本文"}}]}"#;
        assert_eq!(whole_body_content(body).as_deref(), Some("本文"));
        // SSE でも、中身が空でも、JSON でなくても `None`。
        assert_eq!(whole_body_content("data: [DONE]"), None);
        assert_eq!(whole_body_content(r#"{"choices":[]}"#), None);
        assert_eq!(whole_body_content(""), None);
    }

    // ---- ホールドバック（チャンクをまたぐマスク）------------------------------

    /// **1 文字ずつ届いてもキーが漏れない。**
    ///
    /// チャンクごとに `sanitize` を掛けるだけだと、切れ目で割れたキーが素通りする。
    #[test]
    fn masks_a_key_that_arrives_one_character_at_a_time() {
        let key = "supersecretkey-0123456789";
        let text = format!("前置き {key} 後書き{}", "x".repeat(HOLDBACK_CHARS));

        let mut masker = Masker::new(key);
        let mut streamed = String::new();
        for character in text.chars() {
            streamed.push_str(&masker.push(&character.to_string()));
        }
        let (rest, full) = masker.finish();
        streamed.push_str(&rest);

        assert!(!streamed.contains(key), "流した側にキーが出ている: {streamed}");
        assert!(!full.contains(key), "全文にキーが出ている: {full}");
        assert_eq!(streamed, full, "流した差分を繋ぐと全文になること");
        assert!(streamed.contains("前置き") && streamed.contains("後書き"));
    }

    /// **短いうちは何も流さない。** 末尾を手元に残すのが仕事。
    #[test]
    fn holds_everything_back_until_there_is_enough() {
        let mut masker = Masker::new("k");
        assert_eq!(masker.push("みじかい"), "", "ホールドバックの幅に満たない");
        let (rest, full) = masker.finish();
        assert_eq!(rest, "みじかい");
        assert_eq!(full, "みじかい");
    }

    /// **キーが空でも壊れない**（Ollama は認証不要）。
    #[test]
    fn works_without_a_key() {
        let mut masker = Masker::new("");
        let long = "あ".repeat(HOLDBACK_CHARS + 10);
        let head = masker.push(&long);
        let (rest, full) = masker.finish();
        assert_eq!(format!("{head}{rest}"), long);
        assert_eq!(full, long);
    }

    // ---- 400 の見立て（決定 4）------------------------------------------------

    #[test]
    fn tells_apart_the_four_hundreds_it_can_explain() {
        let status = |message: &str| {
            http_error(400, "http://x/v1/chat/completions", message).expect("400 は失敗")
        };

        assert_eq!(
            retry_hint(&status(
                r#"{"error":{"message":"response_format is not supported"}}"#
            )),
            RetryHint::DropResponseFormat
        );
        for said in [
            r#"{"error":{"message":"This model's maximum context length is 4096 tokens"}}"#,
            r#"{"error":"prompt is too long"}"#,
            r#"{"error":{"message":"too many tokens in the request"}}"#,
        ] {
            assert_eq!(retry_hint(&status(said)), RetryHint::SplitInput, "{said}");
        }
        // **見立てが立たないものは投げ直さない。**
        assert_eq!(
            retry_hint(&status(r#"{"error":{"message":"model not found"}}"#)),
            RetryHint::None
        );
        assert_eq!(retry_hint(&status("")), RetryHint::None);
    }

    /// 通信そのものの失敗は投げ直しても同じ。
    #[test]
    fn does_not_suggest_a_retry_for_a_failure_that_never_reached_the_server() {
        assert_eq!(
            retry_hint(&super::LlmError::config("接続先が選ばれていません")),
            RetryHint::None
        );
        let unauthorized = http_error(401, "http://x", r#"{"error":{"message":"bad key"}}"#)
            .expect("401 は失敗");
        assert_eq!(retry_hint(&unauthorized), RetryHint::None);
    }
}
