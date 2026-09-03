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

use crate::model::RepositorySnapshot;

pub use lane::{Edge, GraphRow, LaneLayout};
pub use order::GraphOrder;

/// スナップショット 1 つ分のレーンを確定する。
///
/// 幹（lane 0）の起点は [`RepositorySnapshot::default_branch`]。これは **SHA ではなく
/// 完全な ref 名**（`refs/heads/main`）なので、`refs` から引いて SHA に直してから渡す。
pub fn layout(snapshot: &RepositorySnapshot, order: GraphOrder) -> LaneLayout {
    let start = lane::trunk_start(&snapshot.refs, snapshot.default_branch.as_deref());

    // 幹は第一親チェーンなので並び順に依らない。1 度だけ求めて使い回す。
    let trunk = lane::trunk_chain(&snapshot.commits, start);

    match order {
        GraphOrder::Topo => lane::assign_lanes(&snapshot.commits, &trunk),
        GraphOrder::Date => lane::assign_lanes(&order::by_date(&snapshot.commits), &trunk),
    }
}
