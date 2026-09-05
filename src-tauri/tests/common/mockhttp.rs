//! テスト用の HTTP サーバ。**`std::net::TcpListener` の自作**（T-20 で決めた）。
//!
//! 必要なのは固定の応答を返して要求を記録することだけなので、dev-dependency を増やさない。
//!
//! ここは `src-tauri/src` の外なので好きにプロセスやソケットを扱ってよい。

#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

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
}

impl Canned {
    pub fn json(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: body.into(),
        }
    }

    pub fn text(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            content_type: "text/html; charset=utf-8",
            body: body.into(),
        }
    }
}

type Handler = Box<dyn Fn(&Recorded) -> Canned + Send + Sync>;

pub struct MockServer {
    port: u16,
    requests: Arc<Mutex<Vec<Recorded>>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl MockServer {
    /// 受け取った要求ごとに `handler` の応答を返すサーバを起こす。
    pub fn start(handler: impl Fn(&Recorded) -> Canned + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("ローカルに bind できること");
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));

        let handler: Handler = Box::new(handler);
        let worker = {
            let requests = requests.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(stream) = stream else { continue };
                    if let Some(request) = read_request(&stream) {
                        let response = handler(&request);
                        requests.lock().unwrap().push(request);
                        write_response(stream, &response);
                    }
                }
            })
        };

        Self {
            port,
            requests,
            stop,
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
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        _ => "Status",
    };
    let head = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status,
        response.content_type,
        response.body.len(),
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(response.body.as_bytes());
    let _ = stream.flush();
}
