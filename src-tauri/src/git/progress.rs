//! 読み込みの途中経過。
//!
//! 全件一括取得は 100 万コミット級で十数秒かかる（docs/DESIGN.md §4.1 の実測）。
//! その間ずっと「読み込んでいます…」しか出ないと、固まったのか進んでいるのか分からない。
//!
//! [`LogSink`](crate::commandlog::LogSink) と同じく**トレイトで受ける**。git 側のコードを
//! `AppHandle` に依存させないため（Tauri を積むとユニットテストが動かせなくなる）。

use std::time::Instant;

use serde::Serialize;

/// 読み込みの段階。所要時間の内訳がそのまま段階になっている。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LoadPhase {
    /// `for-each-ref` と HEAD 判定。数十 ms で終わる。
    Refs,
    /// `git log` の全件ダンプ。ここが時間のほぼ全部。
    Commits,
    /// 到達可能集合の判定と幹の決定。
    Graph,
    /// フロントへ渡すための直列化と転送。100 万コミットでは 450MB になる。
    Transfer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadProgress {
    pub phase: LoadPhase,
    /// ここまでに読めたコミット数。`Commits` 以外の段階では最終値。
    pub commits: u64,
    /// 前回の読み込み件数。**割合はこれを分母にした概算**で、確定値ではない。
    /// 初回は分からないので `None`（件数だけ出す）。
    pub estimated_total: Option<u64>,
    pub elapsed_ms: u64,
}

/// 途中経過の受け口。
pub trait ProgressSink {
    fn report(&self, progress: LoadProgress);
}

/// 何もしない実装。テストと、途中経過を要らない呼び出しで使う。
impl ProgressSink for () {
    fn report(&self, _progress: LoadProgress) {}
}

/// 「どこへ・何を分母に・いつから」を 1 つにまとめたもの。
///
/// 読み込みの関数へ 3 つ別々に渡すと引数が増えすぎるうえ、経過時間の起点を
/// 取り違えて段階ごとにばらばらの値を報告する事故が起きる。
pub struct Reporting<'a> {
    sink: &'a dyn ProgressSink,
    /// 前回件数。割合の分母にするだけで、取得内容には影響しない。
    estimated_total: Option<u64>,
    /// 経過時間の起点。**全段階で共通**でなければ意味が無い。
    started: Instant,
}

impl<'a> Reporting<'a> {
    pub fn new(sink: &'a dyn ProgressSink, estimated_total: Option<u64>) -> Self {
        Self {
            sink,
            estimated_total,
            started: Instant::now(),
        }
    }

    /// 何も報告しない。テストと、途中経過が要らない呼び出し用。
    pub fn silent() -> Reporting<'static> {
        Reporting::new(&(), None)
    }

    pub fn report(&self, phase: LoadPhase, commits: u64) {
        self.sink.report(LoadProgress {
            phase,
            commits,
            estimated_total: self.estimated_total,
            elapsed_ms: self.started.elapsed().as_millis() as u64,
        });
    }

}
