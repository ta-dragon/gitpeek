//! レーン割り当て（T-05）を生成済みリポジトリに対して通す結合テスト。
//!
//! 形ごとの期待レーン配列は `src/graph/lane.rs` のユニットテスト側で見る。
//! ここで見るのは「**実物の履歴で panic せず、不変条件が崩れない**」こと。

mod common;

use std::collections::{HashMap, HashSet};

use givsoner_lib::graph::{self, GraphOrder, LaneLayout};
use givsoner_lib::git::snapshot;
use givsoner_lib::model::RepositorySnapshot;
use givsoner_lib::store::settings::VisibleRefs;

use common::{fixtures, log};

/// `make-test-repos.sh` が作るリポジトリ全部。増えたらここに足す。
const REPOSITORIES: [&str; 14] = [
    "linear",
    "branch-merge",
    "merges",
    "octopus",
    "two-roots",
    "orphan",
    "japanese",
    "empty-subject",
    "empty",
    "detached",
    "messages",
    "tags",
    "bare.git",
    "cloned",
];

fn snapshot_of(name: &str) -> RepositorySnapshot {
    snapshot::load(&log(), "git", &fixtures().join(name))
        .unwrap_or_else(|error| panic!("{name} を読めません: {error}"))
}

fn trunk_of(snapshot: &RepositorySnapshot) -> HashSet<String> {
    graph::lane::trunk_chain(
        &snapshot.commits,
        graph::lane::trunk_start(&snapshot.refs, snapshot.default_branch.as_deref()),
    )
}

/// どの並び順でも崩れてはいけないこと。
fn assert_invariants(name: &str, snapshot: &RepositorySnapshot, layout: &LaneLayout) {
    let trunk = trunk_of(snapshot);
    let known: HashSet<&str> = snapshot
        .commits
        .iter()
        .map(|commit| commit.sha.as_str())
        .collect();

    assert_eq!(
        layout.rows.len(),
        snapshot.commits.len(),
        "{name}: 行数がコミット数と違う"
    );

    let mut seen = HashSet::new();
    for row in &layout.rows {
        assert!(seen.insert(&row.sha), "{name}: {} が 2 行ある", row.sha);

        // lane 0 は幹の予約（CLAUDE.md §3-1）。
        if trunk.contains(&row.sha) {
            assert_eq!(row.lane, 0, "{name}: 幹 {} が lane 0 に無い", row.sha);
        } else {
            assert_ne!(row.lane, 0, "{name}: 幹でない {} が lane 0 に乗った", row.sha);
        }

        assert!(row.lane <= layout.max_lane, "{name}: max_lane を超えた行");
        assert!(
            !row.passing.contains(&row.lane),
            "{name}: passing に自分のレーンが入っている"
        );

        for edge in &row.edges {
            assert_eq!(edge.from_lane, row.lane, "{name}: 辺の起点がずれている");
            assert!(edge.to_lane <= layout.max_lane, "{name}: 辺が max_lane を超えた");
            assert!(
                known.contains(edge.parent_sha.as_str()),
                "{name}: 辺の親 {} が読み込んだコミットに無い",
                edge.parent_sha
            );
        }
    }
}

/// 親が必ず後ろに来ること。[`graph::lane::assign_lanes`] の前提そのもの。
fn assert_parents_come_last(name: &str, layout: &LaneLayout) {
    let position: HashMap<&str, usize> = layout
        .rows
        .iter()
        .enumerate()
        .map(|(i, row)| (row.sha.as_str(), i))
        .collect();

    for (i, row) in layout.rows.iter().enumerate() {
        for edge in &row.edges {
            let parent = position[edge.parent_sha.as_str()];
            assert!(
                parent > i,
                "{name}: 親 {} が子 {} より前に出ている",
                edge.parent_sha,
                row.sha
            );
        }
    }
}

#[test]
fn every_generated_repository_lays_out_without_panicking() {
    for name in REPOSITORIES {
        let snapshot = snapshot_of(name);

        for order in [GraphOrder::Topo, GraphOrder::Date] {
            let layout = graph::layout(&snapshot, &VisibleRefs::default(), order);
            assert_invariants(name, &snapshot, &layout);
            assert_parents_come_last(name, &layout);
        }
    }
}

#[test]
fn an_empty_repository_has_no_rows() {
    let snapshot = snapshot_of("empty");
    let layout = graph::layout(&snapshot, &VisibleRefs::default(), GraphOrder::Topo);

    assert!(layout.rows.is_empty());
    assert_eq!(layout.max_lane, 0);
}

#[test]
fn the_branch_merge_fixture_keeps_the_trunk_straight() {
    let snapshot = snapshot_of("branch-merge");
    let layout = graph::layout(&snapshot, &VisibleRefs::default(), GraphOrder::Topo);

    // 既定ブランチ（main）の第一親チェーンが lane 0 を一直線に通る。
    let trunk = trunk_of(&snapshot);
    assert!(trunk.len() >= 2, "幹が引けていない");
    assert!(layout.max_lane >= 1, "枝がレーンを起こしていない");

    let on_lane_zero: HashSet<&str> = layout
        .rows
        .iter()
        .filter(|row| row.lane == 0)
        .map(|row| row.sha.as_str())
        .collect();
    let expected: HashSet<&str> = trunk.iter().map(String::as_str).collect();
    assert_eq!(on_lane_zero, expected);
}

#[test]
fn a_detached_head_still_gets_a_trunk() {
    // detached ＋ main/master 無しでも lane 0 を空けない（先頭コミットを幹にする）。
    let snapshot = snapshot_of("detached");
    let layout = graph::layout(&snapshot, &VisibleRefs::default(), GraphOrder::Topo);

    assert!(!layout.rows.is_empty());
    assert!(
        layout.rows.iter().any(|row| row.lane == 0),
        "lane 0 が空のままになっている"
    );
}

#[test]
fn date_order_keeps_the_same_rows() {
    let snapshot = snapshot_of("merges");

    let topo = graph::layout(&snapshot, &VisibleRefs::default(), GraphOrder::Topo);
    let date = graph::layout(&snapshot, &VisibleRefs::default(), GraphOrder::Date);

    let of = |layout: &LaneLayout| -> HashSet<String> {
        layout.rows.iter().map(|row| row.sha.clone()).collect()
    };
    assert_eq!(of(&topo), of(&date), "並び替えで行が増減している");
}
