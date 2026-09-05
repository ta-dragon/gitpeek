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

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use ureq::Agent;

use crate::redact::redact;
use crate::store::settings::LlmProfile;

/// 接続の待ち時間。**ローカル Ollama は初回のモデルロードで数十秒かかる**ので、
/// 短くすると「壊れている」ように見える。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);

/// 接続テストで使う `max_tokens`。**プロファイルの値は使わない** — 疎通の確認に
/// 何千トークンも生成させない。
const PROBE_MAX_TOKENS: u32 = 16;

/// 生の応答を画面へ出すときの上限。長い HTML のエラーページを丸ごと抱えない。
const RAW_LIMIT: usize = 4_000;

/// 見出しに載せるサーバ側の説明の長さ。これを超えたら切って、続きは `detail` で読ませる。
const HEADLINE_LIMIT: usize = 200;

/// 失敗の種類。**画面はこれで文言と復旧手順を出し分ける。**
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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
#[derive(Debug, Clone, PartialEq, Serialize)]
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
}
