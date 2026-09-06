//! LLM クライアントの結合テスト（T-20）。
//!
//! **モックサーバは自作**（`common/mockhttp.rs`）。ここで見るのは
//!
//! - 失敗を**言い分けられる**こと（401 / 404 / JSON でない応答 / 接続不可）
//! - **API キーが結果に 1 文字も現れない**こと（サーバが echo してきても）
//! - `Authorization` が**キーの無いときに付かない**こと（Ollama 向け）
//! - base URL の末尾スラッシュで**実際に飛ぶパスが変わらない**こと
//!
//! いずれも「組み立てが正しいこと」ではなく **実際に飛んだ要求** で確かめている
//! （T-18 で、組み立てだけ固定して 1 度も動かない経路を作った）。

// git のテストリポジトリ生成には用が無いので、`common/mod.rs` は取り込まない。
#[path = "common/mockhttp.rs"]
mod mockhttp;

use gitpeek_lib::llm::client::{list_models, test_connection, LlmErrorKind};
use gitpeek_lib::store::settings::LlmProfile;
use mockhttp::{closed_port, Canned, MockServer};

/// 応答の見本。OpenAI / Ollama / vLLM のどれもこの形で返す。
const MODELS_JSON: &str = r#"{"object":"list","data":[
    {"id":"qwen2.5-coder:14b","object":"model"},
    {"id":"gpt-4o-mini","object":"model"}
]}"#;

const CHAT_JSON: &str = r#"{"id":"chatcmpl-1","object":"chat.completion","model":"qwen2.5-coder:14b",
  "choices":[{"index":0,"message":{"role":"assistant","content":"pong"},"finish_reason":"stop"}]}"#;

fn profile(base_url: &str) -> LlmProfile {
    LlmProfile {
        id: "p1".to_string(),
        name: "テスト接続先".to_string(),
        base_url: base_url.to_string(),
        model: "qwen2.5-coder:14b".to_string(),
        credential_key: "llm/test".to_string(),
        ..LlmProfile::default()
    }
}

/// 結果のうち**画面とログへ出る文字列**を全部つなげたもの。
/// キーが混ざっていないことをここで一括して見る。
fn visible(text: impl std::fmt::Debug) -> String {
    format!("{text:?}")
}

#[test]
fn lists_models_from_a_healthy_server() {
    let server = MockServer::always(Canned::json(200, MODELS_JSON));
    let list = list_models(&profile(&server.base_url()), "").expect("一覧が取れること");

    assert_eq!(list.models, vec!["gpt-4o-mini", "qwen2.5-coder:14b"]);

    let request = server.last();
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/v1/models");
}

#[test]
fn runs_one_round_trip_for_the_connection_test() {
    // **`/v1/models` だけで済ませない。** 生成まで通ることを見る。
    let server = MockServer::always(Canned::json(200, CHAT_JSON));
    let outcome = test_connection(&profile(&server.base_url()), "").expect("疎通すること");

    assert_eq!(outcome.model, "qwen2.5-coder:14b");
    assert_eq!(outcome.reply, "pong");
    assert!(outcome.raw.contains("chat.completion"), "生の応答を残す");

    let request = server.last();
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/v1/chat/completions");
    assert!(
        request.body.contains("qwen2.5-coder:14b"),
        "モデル名を送ること: {}",
        request.body
    );
    assert!(
        request.body.contains("\"stream\":false"),
        "接続テストはストリーミングしない: {}",
        request.body
    );
}

/// `http://.../v1/` を貼られても壊れない。
#[test]
fn a_trailing_slash_in_the_base_url_does_not_change_the_request() {
    let server = MockServer::always(Canned::json(200, MODELS_JSON));

    list_models(&profile(&server.base_url()), "").unwrap();
    let plain = server.last().path;

    list_models(&profile(&format!("{}///", server.base_url())), "").unwrap();
    let slashed = server.last().path;

    assert_eq!(plain, slashed);
    assert_eq!(plain, "/v1/models");
}

/// **Ollama 向け。** キーが空なら `Authorization` を付けない。
#[test]
fn sends_no_authorization_header_when_the_key_is_empty() {
    let server = MockServer::always(Canned::json(200, CHAT_JSON));
    test_connection(&profile(&server.base_url()), "").unwrap();

    assert_eq!(server.last().header("authorization"), None);
}

#[test]
fn sends_a_bearer_header_when_a_key_is_set() {
    let server = MockServer::always(Canned::json(200, CHAT_JSON));
    test_connection(&profile(&server.base_url()), "sk-example-key-0123456789").unwrap();

    assert_eq!(
        server.last().header("authorization"),
        Some("Bearer sk-example-key-0123456789")
    );
}

#[test]
fn tells_an_unauthorized_response_apart() {
    let server = MockServer::always(Canned::json(
        401,
        r#"{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}"#,
    ));
    let key = "sk-example-key-0123456789";
    let error = test_connection(&profile(&server.base_url()), key).unwrap_err();

    assert_eq!(error.kind, LlmErrorKind::Unauthorized);
    assert!(error.message.contains("API キー"), "{}", error.message);
    assert!(
        error.detail.contains("Incorrect API key"),
        "生の応答を展開で見せる: {}",
        error.detail
    );
    assert!(!visible(&error).contains(key), "キーが出てはいけない");
}

#[test]
fn tells_a_not_found_response_apart() {
    let server = MockServer::always(Canned::json(404, r#"{"error":"not found"}"#));
    let error = test_connection(&profile(&server.base_url()), "").unwrap_err();

    assert_eq!(error.kind, LlmErrorKind::NotFound);
    // 「何をすればいいか」まで書いてあること（CLAUDE.md §6）。
    assert!(error.message.contains("/v1"), "{}", error.message);
}

/// **JSON でない応答。** リバースプロキシがエラーページを返す形。
#[test]
fn tells_a_non_json_response_apart() {
    let server = MockServer::always(Canned::text(
        200,
        "<html><body><h1>502 Bad Gateway</h1></body></html>",
    ));
    let key = "sk-example-key-0123456789";
    let error = test_connection(&profile(&server.base_url()), key).unwrap_err();

    assert_eq!(error.kind, LlmErrorKind::BadResponse);
    assert!(
        error.detail.contains("Bad Gateway"),
        "生の応答を見せる: {}",
        error.detail
    );
    assert!(!visible(&error).contains(key));
}

/// 200 で JSON だが OpenAI 互換の形ではない場合も同じ扱いにする。
#[test]
fn tells_a_json_response_without_choices_apart() {
    let server = MockServer::always(Canned::json(200, r#"{"ok":true}"#));
    let error = test_connection(&profile(&server.base_url()), "").unwrap_err();

    assert_eq!(error.kind, LlmErrorKind::BadResponse);
    assert!(error.message.contains("choices"), "{}", error.message);
}

#[test]
fn tells_an_unreachable_server_apart() {
    let base = format!("http://127.0.0.1:{}/v1", closed_port());
    let key = "sk-example-key-0123456789";
    let error = test_connection(&profile(&base), key).unwrap_err();

    assert_eq!(error.kind, LlmErrorKind::Unreachable);
    assert!(
        error.message.contains("起動している"),
        "{}",
        error.message
    );
    assert!(!visible(&error).contains(key));
}

#[test]
fn rejects_a_base_url_that_is_not_http_without_touching_the_network() {
    for base in ["", "localhost:11434/v1"] {
        let error = test_connection(&profile(base), "").unwrap_err();
        assert_eq!(error.kind, LlmErrorKind::BadUrl, "{base}");
    }
}

/// **1 文字のキーで本文が壊れないこと**（2026-09-05 の目視で見つかった）。
///
/// マスクを素の `replace` でやっていたころ、キーが `a` だと 401 の本文が
/// `{"error":{"mess***ge":"Inv***lid token p***ylo***d"}}` になった。
/// JSON のキー名まで潰れるので、**理由が見出しへ上がらず、整形もできなくなる。**
/// 本文は unsloth desktop が実際に返した形。
#[test]
fn a_one_letter_key_leaves_the_error_body_readable() {
    let server = MockServer::always(Canned::json(
        401,
        r#"{"error":{"message":"Invalid token payload","type":"authentication_error","param":null,"code":null}}"#,
    ));
    let error = test_connection(&profile(&server.base_url()), "a").unwrap_err();

    assert_eq!(error.kind, LlmErrorKind::Unauthorized);
    // 理由が見出しへ上がること。
    assert!(
        error.message.contains("Invalid token payload"),
        "{}",
        error.message
    );
    // 生の応答が JSON のまま届くこと（フロントはこれを整形する）。
    assert!(error.detail.contains(r#""message""#), "{}", error.detail);
    assert!(!error.detail.contains("***"), "{}", error.detail);
    serde_json::from_str::<serde_json::Value>(&error.detail).expect("JSON として読めること");

    // それでも Authorization は飛んでいる。
    assert_eq!(server.last().header("authorization"), Some("Bearer a"));
}

/// **サーバがキーを送り返してきても結果に出さない。**
///
/// `redact` の規則に当たらない形のキー（自前サーバの任意文字列）でも同じ。
#[test]
fn never_leaks_the_key_even_when_the_server_echoes_it() {
    let server = MockServer::start(|request| {
        let echoed = request.header("authorization").unwrap_or("(none)").to_string();
        Canned::text(500, format!("rejected credential: {echoed}"))
    });
    let key = "totally-ordinary-looking-value";

    let error = test_connection(&profile(&server.base_url()), key).unwrap_err();
    assert_eq!(error.kind, LlmErrorKind::Status);
    assert!(
        error.detail.contains("rejected credential"),
        "生の応答は見せる: {}",
        error.detail
    );
    assert!(
        !visible(&error).contains(key),
        "キーが結果に出てはいけない: {}",
        error.detail
    );

    // モデル一覧側も同じ。
    let error = list_models(&profile(&server.base_url()), key).unwrap_err();
    assert!(!visible(&error).contains(key));
}
