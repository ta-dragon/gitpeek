//! テスト用の HTTP サーバ。**`std::net::TcpListener` の自作**（T-20 で決めた）。
//!
//! 必要なのは固定の応答を返して要求を記録することだけなので、dev-dependency を増やさない。
//!
//! T-22 で 3 つ足した。
//!
//! - **少しずつ返す**（SSE のチャンク）。ストリーミングと中止を実際に流して見るため
//! - **接続ごとにスレッドを起こす**。並列度 3 で本当に 3 本走ることを見るため
//! - **同時接続数の記録**。上と同じ理由
//!
//! ここは `src-tauri/src` の外なので好きにプロセスやソケットを扱ってよい。

#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

/// サーバが受け取った要求。**ヘッダも本文も残す** —
/// `Authorization` が付いたか / どのパスへ行ったかを、組み立てではなく
/// **実際に飛んだ要求**で確かめるため。
#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    /// ヘッダ名は小文字に揃えてある。
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// 返す応答。
#[derive(Debug, Clone)]
pub struct Canned {
    pub status: u16,
    pub content_type: &'static str,
    pub body: String,
    /// 本文を分けて書き出す 1 回ぶんのバイト数。`None` なら一度に書く。
    pub chunk_bytes: Option<usize>,
    /// チャンクとチャンクの間隔。中止を割り込ませる隙を作るために使う。
    pub chunk_delay: Duration,
}

impl Canned {
    pub fn json(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: body.into(),
            chunk_bytes: None,
            chunk_delay: Duration::ZERO,
        }
    }

    pub fn text(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            content_type: "text/html; charset=utf-8",
            body: body.into(),
            chunk_bytes: None,
            chunk_delay: Duration::ZERO,
        }
    }

    /// SSE の本文をそのまま返す。**行の組み立ては呼び出し側**（壊れた行も流したいので）。
    pub fn sse(body: impl Into<String>) -> Self {
        Self {
            status: 200,
            content_type: "text/event-stream",
            body: body.into(),
            chunk_bytes: None,
            chunk_delay: Duration::ZERO,
        }
    }

    /// `content` を 1 つの `data:` 行にした SSE。終わりに `[DONE]` を付ける。
    pub fn sse_content(content: &str) -> Self {
        Self::sse(format!("{}{}", sse_delta(content), SSE_DONE))
    }

    /// 少しずつ返す。**中止とチャンクまたぎを見るため。**
    pub fn in_chunks(mut self, bytes: usize, delay: Duration) -> Self {
        self.chunk_bytes = Some(bytes);
        self.chunk_delay = delay;
        self
    }
}

/// `data: {...}` を 1 行作る。
pub fn sse_delta(content: &str) -> String {
    let payload = serde_json::json!({
        "choices": [{ "index": 0, "delta": { "content": content } }]
    });
    format!("data: {payload}\n\n")
}

/// `finish_reason` を伝える 1 行。
pub fn sse_finish(reason: &str) -> String {
    let payload = serde_json::json!({
        "choices": [{ "index": 0, "delta": {}, "finish_reason": reason }]
    });
    format!("data: {payload}\n\n")
}

pub const SSE_DONE: &str = "data: [DONE]\n\n";

type Handler = Box<dyn Fn(&Recorded) -> Canned + Send + Sync>;

pub struct MockServer {
    port: u16,
    requests: Arc<Mutex<Vec<Recorded>>>,
    stop: Arc<AtomicBool>,
    /// 同時に開いていた接続の最大数。**並列度の確認に使う。**
    peak: Arc<AtomicUsize>,
    worker: Option<JoinHandle<()>>,
}

impl MockServer {
    /// 受け取った要求ごとに `handler` の応答を返すサーバを起こす。
    ///
    /// **接続ごとにスレッドを起こす。** 1 本ずつ捌くと、並列に投げても
    /// 直列にしか見えない（並列度のテストが通ってしまう）。
    pub fn start(handler: impl Fn(&Recorded) -> Canned + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("ローカルに bind できること");
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let peak = Arc::new(AtomicUsize::new(0));

        let handler: Handler = Box::new(handler);
        let handler = Arc::new(handler);
        let worker = {
            let requests = requests.clone();
            let stop = stop.clone();
            let peak = peak.clone();
            std::thread::spawn(move || {
                let live = Arc::new(AtomicUsize::new(0));
                let mut connections: Vec<JoinHandle<()>> = Vec::new();
                for stream in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(stream) = stream else { continue };
                    let handler = handler.clone();
                    let requests = requests.clone();
                    let live = live.clone();
                    let peak = peak.clone();
                    connections.push(std::thread::spawn(move || {
                        let Some(request) = read_request(&stream) else {
                            return;
                        };
                        let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);

                        let response = handler(&request);
                        requests.lock().unwrap().push(request);
                        write_response(stream, &response);

                        live.fetch_sub(1, Ordering::SeqCst);
                    }));
                }
                for connection in connections {
                    let _ = connection.join();
                }
            })
        };

        Self {
            port,
            requests,
            stop,
            peak,
            worker: Some(worker),
        }
    }

    /// 常に同じ応答を返すサーバ。
    pub fn always(response: Canned) -> Self {
        Self::start(move |_| response.clone())
    }

    /// プロファイルに入れる base URL。**末尾にスラッシュは付けない。**
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }

    /// 最後に受けた要求。1 度も来ていなければ panic する（テストの意図が外れている）。
    pub fn last(&self) -> Recorded {
        self.requests()
            .pop()
            .expect("サーバへ要求が 1 件も届いていない")
    }

    /// 同時に開いていた接続の最大数。
    pub fn peak_concurrency(&self) -> usize {
        self.peak.load(Ordering::SeqCst)
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // accept で止まっているスレッドを 1 本だけ叩き起こす。
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// **接続できないポート**を 1 つ返す。bind して番号を取り、すぐ手放す。
pub fn closed_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("ローカルに bind できること");
    listener.local_addr().unwrap().port()
}

fn read_request(stream: &TcpStream) -> Option<Recorded> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);

    let mut start = String::new();
    if reader.read_line(&mut start).ok()? == 0 {
        // 停止用のダミー接続。
        return None;
    }
    let mut parts = start.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();

    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            break;
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        headers.push((
            name.trim().to_ascii_lowercase(),
            value.trim().to_string(),
        ));
    }

    let length: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if length > 0 {
        reader.read_exact(&mut body).ok()?;
    }

    Some(Recorded {
        method,
        path,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

fn write_response(mut stream: TcpStream, response: &Canned) {
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        _ => "Status",
    };
    // **少しずつ返すときも Content-Length は付ける。** 長さは分かっているので
    // chunked にする必要が無く、受け側は先に長さを知っていても
    // 「届いた分から読む」ことに変わりはない。
    let head = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status,
        response.content_type,
        response.body.len(),
    );
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    let _ = stream.flush();

    let bytes = response.body.as_bytes();
    match response.chunk_bytes {
        None => {
            let _ = stream.write_all(bytes);
            let _ = stream.flush();
        }
        Some(size) => {
            let size = size.max(1);
            for (index, piece) in bytes.chunks(size).enumerate() {
                // **待つのは書く前。** 最後のチャンクの後に眠ると、
                // 相手はもう読み終えているのに接続だけが残り、
                // 次の要求と重なって「同時に 2 本」に見える。
                if index > 0 && !response.chunk_delay.is_zero() {
                    std::thread::sleep(response.chunk_delay);
                }
                // 相手が中止して接続を切ったら、そこでやめる。
                if stream.write_all(piece).is_err() || stream.flush().is_err() {
                    return;
                }
            }
        }
    }
}
