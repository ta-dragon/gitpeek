//! フロントへ渡すグラフのデータモデル。
//!
//! **リポジトリ選択時に全コミットのメタ情報を一括で載せる**（docs/DESIGN.md §4.1）。
//! 増分読みをしないのは、後から現れた親でレーン割り当てが遡って変わり、
//! 描画中にグラフが踊るため（CLAUDE.md §3-5）。
//!
//! ここに置くのは「取得した事実」だけで、レーン番号や到達可能集合といった
//! 計算結果は持たない（T-05 以降で別の型に載せる）。

use serde::Serialize;

/// コミット 1 件のメタ情報。本文・差分は含まない（選択時に遅延取得する）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMeta {
    pub sha: String,
    /// `%h`。何桁で一意になるかの判断は git に委ねる。
    pub short_sha: String,
    /// 第一親が先頭。マージコミットは 2 件以上、ルートコミットは 0 件。
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Unix 秒。表示形式はフロントで決める。
    pub author_time: i64,
    pub commit_time: i64,
    pub subject: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    LocalBranch,
    RemoteBranch,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefEntry {
    /// 完全な ref 名（`refs/heads/main`）。同名の別種を取り違えないためこちらを正とする。
    pub name: String,
    /// 表示用（`main` / `origin/main` / `v1.0`）。
    pub short_name: String,
    pub kind: RefKind,
    /// 指すコミット SHA。annotated tag は peel 後のコミット。
    pub target: String,
    /// 上流ブランチの完全な ref 名。無ければ `None`。
    pub upstream: Option<String>,
    /// `target` が読み込んだコミット集合に含まれない（docs/DESIGN.md §4.2）。
    /// タグは起点 ref にしないので、どのブランチからも到達できない古いタグがこれになる。
    pub out_of_graph: bool,
}

/// HEAD の状態を 1 つの構造体に平らにしたもの。
///
/// [`crate::git::repo::HeadState`] が「一覧の 1 行を描くための判別」なのに対し、
/// こちらは「グラフ上のどこに印を付けるか」を引くためのもの。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadInfo {
    /// コミット 0 件（unborn）のときだけ `None`。
    pub sha: Option<String>,
    /// detached のときだけ `None`。
    pub branch: Option<String>,
    pub detached: bool,
    pub unborn: bool,
}

/// リポジトリ 1 つ分の読み込み結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    /// topo-order。date-order への切替は再実行せずメモリ上で並べ替える（§4.3）。
    pub commits: Vec<CommitMeta>,
    pub refs: Vec<RefEntry>,
    pub head: HeadInfo,
    /// lane 0 を予約する幹の ref 名（完全形）。決められなければ `None`。
    pub default_branch: Option<String>,
    /// 読み込んだ時刻（RFC 3339）。
    pub loaded_at: String,
    /// 全 ref と HEAD から作る指紋。キャッシュの無効化はこれの変化で判定する（§4.1）。
    pub ref_fingerprint: String,
}

impl RepositorySnapshot {
    /// コミット 0 件か。空リポジトリの表示分岐に使う。
    pub fn is_empty(&self) -> bool {
        self.commits.is_empty()
    }
}
