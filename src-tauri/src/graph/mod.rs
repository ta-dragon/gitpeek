//! 描画用のグラフ構造。**このアプリの心臓部**（CLAUDE.md §3）。
//!
//! ここが返すのは「どのコミットがどのレーンに乗り、どの線がどこへ伸びるか」だけで、
//! 色も座標も持たない。色はフロント側の純関数が決める（docs/DESIGN.md §5.2 / T-06）。
//!
//! レーンは**全件を一度で確定**する。増分計算をしないのは、後から現れた親で
//! 割り当てが遡って変わり、描画中にグラフが踊るため（CLAUDE.md §3-5）。

pub mod component;
pub mod lane;
pub mod order;
pub mod reach;

use crate::model::{RefKind, RepositorySnapshot};
use crate::store::settings::VisibleRefs;

pub use lane::{Edge, GraphRow, LaneLayout};
pub use order::GraphOrder;

/// スナップショット 1 つ分のレーンを確定する。
///
/// 幹（lane 0）の起点は [`RepositorySnapshot::default_branch`]。これは **SHA ではなく
/// 完全な ref 名**（`refs/heads/main`）なので、`refs` から引いて SHA に直してから渡す。
///
/// `visible` で ref を絞ると、**到達可能集合を計算し直してレーンを振り直す**
/// （淡色化ではない — CLAUDE.md §3-7）。行数も線の本数も実際に減る。
pub fn layout(
    snapshot: &RepositorySnapshot,
    visible: &VisibleRefs,
    order: GraphOrder,
) -> LaneLayout {
    let start = lane::trunk_start(&snapshot.refs, snapshot.default_branch.as_deref());

    match visible_commits(snapshot, visible) {
        // 全表示。**この経路では 1 件も複製しない**（ふつうはこちらを通る）。
        None => {
            // 幹は第一親チェーンなので並び順に依らない。1 度だけ求めて使い回す。
            let trunk = lane::trunk_chain(&snapshot.commits, start);
            match order {
                GraphOrder::Topo => lane::assign_lanes(&snapshot.commits, &trunk),
                GraphOrder::Date => lane::assign_lanes(&order::by_date(&snapshot.commits), &trunk),
            }
        }
        Some(commits) => {
            // 幹の ref を非表示にされると起点が絞った集合に残らない。`trunk_chain` は
            // その場合に先頭コミットへ落ちるので、**lane 0 は必ず誰かが通る**。
            let trunk = lane::trunk_chain(&commits, start);
            match order {
                GraphOrder::Topo => lane::assign_lanes(&commits, &trunk),
                GraphOrder::Date => lane::assign_lanes(&order::by_date(&commits), &trunk),
            }
        }
    }
}

/// 可視 ref から辿れるコミットだけを残した列。全表示なら `None`（複製しない）。
///
/// 起点にするのは**ブランチと HEAD だけ**。タグは起点 ref にしないので、
/// チェックの有無はグラフの中身に影響しない（CLAUDE.md §2 / DESIGN.md §4.2）。
/// HEAD を常に含めるのは `git log --branches --remotes HEAD` と揃えるため。
/// 全部のチェックを外しても、今いる場所だけは残る。
fn visible_commits(
    snapshot: &RepositorySnapshot,
    visible: &VisibleRefs,
) -> Option<Vec<crate::model::CommitMeta>> {
    if visible.mode != "custom" || visible.excluded.is_empty() {
        return None;
    }

    let hidden: std::collections::HashSet<&str> =
        visible.excluded.iter().map(String::as_str).collect();

    let mut tips: Vec<String> = snapshot
        .refs
        .iter()
        .filter(|entry| !entry.out_of_graph)
        .filter(|entry| matches!(entry.kind, RefKind::LocalBranch | RefKind::RemoteBranch))
        .filter(|entry| !hidden.contains(entry.name.as_str()))
        .map(|entry| entry.target.clone())
        .collect();
    if let Some(sha) = &snapshot.head.sha {
        tips.push(sha.clone());
    }

    let index = reach::CommitIndex::new(&snapshot.commits);
    let reachable = index.reachable_from(&tips);

    Some(
        snapshot
            .commits
            .iter()
            .filter(|commit| reachable.contains(commit.sha.as_str()))
            .cloned()
            .collect(),
    )
}
