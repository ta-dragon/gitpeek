//! レーン割り当て。**変更したら必ずユニットテストを通すこと**（CLAUDE.md §3）。
//!
//! グラフの美しさの 8 割がここで決まる（docs/DESIGN.md §5.1）。守る不変条件は 4 つ。
//!
//! 1. **lane 0 は幹に予約する。** 既定ブランチの第一親チェーンは必ず lane 0 を
//!    一直線に通り、幹以外は決して lane 0 に乗らない
//! 2. レーン再利用は最小空きレーンだが、**解放直後の [`RESERVE_ROWS`] 行は保留**する。
//!    即座に再利用すると、1 本の線が交差直後に無関係なブランチへ化けて見える
//! 3. マージコミットの第 2 親は**右側に新しいレーンを起こす**
//! 4. **レーン数に上限を設けない**（横スクロールで見せる）
//!
//! 入力の `commits` は **topo-order（親が必ず後ろ）** であることを前提にする。
//! date-order は [`super::order::by_date`] がこの前提を保ったまま並べ替える。

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::model::{CommitMeta, RefEntry};

/// レーンを解放してから再利用を許すまでの行数（docs/DESIGN.md §5.1-2）。
pub const RESERVE_ROWS: usize = 2;

/// ある行から親へ伸びる線 1 本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub from_lane: u32,
    pub to_lane: u32,
    pub parent_sha: String,
    /// 第一親以外（マージの右側）。オクトパスの 3 親目以降も含む。
    pub is_merge_second_parent: bool,
}

/// 描画 1 行分。**色も座標も持たない**（T-06 がフロント側で決める）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub sha: String,
    /// このコミットのノードが乗るレーン。
    pub lane: u32,
    /// この行を素通りする他のレーン。縦線だけを引く。
    pub passing: Vec<u32>,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneLayout {
    pub rows: Vec<GraphRow>,
    /// 実際に使われた最大のレーン番号。グラフ列の幅はこれで決まる。
    pub max_lane: u32,
}

/// 幹の起点コミットを引く。
///
/// [`crate::model::RepositorySnapshot::default_branch`] は **SHA ではなく完全な ref 名**
/// （`refs/heads/main`）。短縮名だとローカルの `main` とリモートの `origin/main` を
/// 区別できないためそうなっている（T-04 の申し送り）。
pub fn trunk_start<'a>(refs: &'a [RefEntry], default_branch: Option<&str>) -> Option<&'a str> {
    let name = default_branch?;
    refs.iter()
        .find(|entry| entry.name == name)
        .map(|entry| entry.target.as_str())
}

/// 幹（lane 0 に予約するコミット集合）を求める。起点から**第一親だけ**を辿る。
///
/// 起点が無い（detached ＋ main/master 無し）ときと、起点がグラフ外を指すときは
/// **先頭コミットを起点にする**。lane 0 を空けたままにすると、グラフ全体が 1 レーン
/// 右へずれた上に左端が永久に空く。topo-order の先頭はいずれかの ref の先端なので、
/// 幹として不自然にはならない。
pub fn trunk_chain(commits: &[CommitMeta], start_sha: Option<&str>) -> HashSet<String> {
    let by_sha = index_by_sha(commits);

    let mut current = start_sha
        .filter(|sha| by_sha.contains_key(sha))
        .or_else(|| commits.first().map(|commit| commit.sha.as_str()));

    let mut trunk = HashSet::new();
    while let Some(sha) = current {
        let Some(commit) = by_sha.get(sha) else { break };
        // 壊れた履歴で無限ループにしない。
        if !trunk.insert(commit.sha.clone()) {
            break;
        }
        current = commit.parents.first().map(String::as_str);
    }
    trunk
}

/// レーンを確定する。`commits` は topo-order、`trunk` は [`trunk_chain`] の結果。
pub fn assign_lanes(commits: &[CommitMeta], trunk: &HashSet<String>) -> LaneLayout {
    // レーン番号 -> そのレーンが待っている親 SHA。
    let mut active: Vec<Option<String>> = Vec::new();
    // 直近に解放されたレーン (レーン番号, 解放した行)。
    let mut freed: Vec<(usize, usize)> = Vec::new();

    let mut rows = Vec::with_capacity(commits.len());
    let mut max_lane = 0usize;

    for (row_index, commit) in commits.iter().enumerate() {
        // 保留期間を過ぎたものは捨てる。この Vec が伸び続けないようにするだけ。
        freed.retain(|(_, at)| row_index - at < RESERVE_ROWS);

        // 1. このコミットが乗るレーンを決める。
        let lane = if trunk.contains(&commit.sha) {
            if active.is_empty() {
                active.push(None);
            }
            0
        } else {
            match waiting_for(&active, &commit.sha) {
                // 子が予約していたレーンを引き継ぐ。
                Some(lane) => lane,
                // どの子からも待たれていない＝ブランチの先端。
                None => allocate_lane(&mut active, &freed, row_index),
            }
        };

        // 2. 同じコミットを待っていた他のレーンを解放する（合流）。
        for (other, slot) in active.iter_mut().enumerate() {
            if other != lane && slot.as_deref() == Some(commit.sha.as_str()) {
                *slot = None;
                freed.push((other, row_index));
            }
        }

        // 3. この行を素通りするレーン。解放済みと自分のレーンは含めない。
        let passing: Vec<u32> = (0..active.len())
            .filter(|&other| other != lane && active[other].is_some())
            .map(|other| other as u32)
            .collect();

        // 4. 親へレーンを割り当てる。
        let mut edges = Vec::with_capacity(commit.parents.len());
        for (nth, parent) in commit.parents.iter().enumerate() {
            let to_lane = if nth == 0 {
                // 第一親は同じレーンを継承する。幹が一直線になるのはこれによる。
                lane
            } else {
                // 第 2 親以降は右に新レーンを起こす。allocate_lane は lane 0 を
                // 返さないので、幹へ戻るマージでも幹は 1 本のまま保たれる。
                allocate_lane(&mut active, &freed, row_index)
            };
            active[to_lane] = Some(parent.clone());
            edges.push(Edge {
                from_lane: lane as u32,
                to_lane: to_lane as u32,
                parent_sha: parent.clone(),
                is_merge_second_parent: nth > 0,
            });
            max_lane = max_lane.max(to_lane);
        }

        // ルートコミット。ここでレーンが終わる。
        if commit.parents.is_empty() {
            active[lane] = None;
            freed.push((lane, row_index));
        }

        max_lane = max_lane.max(lane);
        if let Some(&rightmost) = passing.last() {
            max_lane = max_lane.max(rightmost as usize);
        }

        rows.push(GraphRow {
            sha: commit.sha.clone(),
            lane: lane as u32,
            passing,
            edges,
        });
    }

    LaneLayout {
        rows,
        max_lane: max_lane as u32,
    }
}

fn index_by_sha(commits: &[CommitMeta]) -> HashMap<&str, &CommitMeta> {
    commits
        .iter()
        .map(|commit| (commit.sha.as_str(), commit))
        .collect()
}

/// `sha` を待っている最小のレーン。
fn waiting_for(active: &[Option<String>], sha: &str) -> Option<usize> {
    active.iter().position(|slot| slot.as_deref() == Some(sha))
}

/// 空きレーンを 1 つ取る。**lane 0 は幹の予約なので、空いていても配らない。**
fn allocate_lane(
    active: &mut Vec<Option<String>>,
    freed: &[(usize, usize)],
    row_index: usize,
) -> usize {
    // lane 0 は飛ばす。空いていても幹の席なので配らない。
    let free = active
        .iter()
        .enumerate()
        .skip(1)
        .find(|(lane, slot)| slot.is_none() && !is_reserved(freed, *lane, row_index));
    if let Some((lane, _)) = free {
        return lane;
    }

    // 右端に足す。レーン数に上限は設けない（docs/DESIGN.md §5.1-4）。
    if active.is_empty() {
        active.push(None); // lane 0 は幹の席。
    }
    active.push(None);
    active.len() - 1
}

/// 解放直後で再利用を保留中か。
fn is_reserved(freed: &[(usize, usize)], lane: usize, row_index: usize) -> bool {
    freed
        .iter()
        .any(|&(freed_lane, at)| freed_lane == lane && row_index - at < RESERVE_ROWS)
}

#[cfg(test)]
pub mod tests {
    use super::{assign_lanes, trunk_chain, trunk_start, GraphRow, LaneLayout, RESERVE_ROWS};
    use crate::model::{CommitMeta, RefEntry, RefKind};
    use std::collections::HashSet;

    /// 日時付きのフィクスチャ。`order` 側のテストからも使う。
    pub fn commit_at(sha: &str, parents: &[&str], time: i64) -> CommitMeta {
        CommitMeta {
            sha: sha.to_string(),
            short_sha: sha.chars().take(7).collect(),
            parents: parents.iter().map(|parent| parent.to_string()).collect(),
            author_name: "テスト".to_string(),
            author_email: "test@example.com".to_string(),
            author_time: time,
            commit_time: time,
            subject: sha.to_string(),
        }
    }

    /// DAG を「新しい順」に書く。`("m", &["c", "b"])` は m の第一親が c。
    fn dag(spec: &[(&str, &[&str])]) -> Vec<CommitMeta> {
        spec.iter()
            .enumerate()
            .map(|(i, (sha, parents))| commit_at(sha, parents, 1_000 - i as i64))
            .collect()
    }

    fn layout_of(spec: &[(&str, &[&str])]) -> (HashSet<String>, LaneLayout) {
        let commits = dag(spec);
        let trunk = trunk_chain(&commits, None);
        let layout = assign_lanes(&commits, &trunk);
        (trunk, layout)
    }

    fn lanes(layout: &LaneLayout) -> Vec<u32> {
        layout.rows.iter().map(|row| row.lane).collect()
    }

    fn row<'a>(layout: &'a LaneLayout, sha: &str) -> &'a GraphRow {
        layout
            .rows
            .iter()
            .find(|row| row.sha == sha)
            .unwrap_or_else(|| panic!("行 {sha} が無い"))
    }

    /// 全フィクスチャで検査する不変条件（CLAUDE.md §3-1）。
    fn assert_trunk_owns_lane_zero(layout: &LaneLayout, trunk: &HashSet<String>) {
        for row in &layout.rows {
            if trunk.contains(&row.sha) {
                assert_eq!(
                    row.lane, 0,
                    "幹 {} が lane {} に乗っている",
                    row.sha, row.lane
                );
            } else {
                assert_ne!(row.lane, 0, "幹でない {} が lane 0 に乗っている", row.sha);
            }
            assert!(
                !row.passing.contains(&row.lane),
                "{} の passing に自分のレーンが入っている",
                row.sha
            );
        }
    }

    #[test]
    fn empty_input_produces_no_rows() {
        let layout = assign_lanes(&[], &HashSet::new());
        assert!(layout.rows.is_empty());
        assert_eq!(layout.max_lane, 0);
    }

    #[test]
    fn single_commit_sits_on_lane_zero() {
        let (trunk, layout) = layout_of(&[("a", &[])]);
        assert_eq!(lanes(&layout), [0]);
        assert_eq!(layout.max_lane, 0);
        assert!(row(&layout, "a").edges.is_empty());
        assert_trunk_owns_lane_zero(&layout, &trunk);
    }

    #[test]
    fn linear_history_stays_on_lane_zero() {
        let (trunk, layout) = layout_of(&[("c", &["b"]), ("b", &["a"]), ("a", &[])]);

        assert_eq!(lanes(&layout), [0, 0, 0]);
        assert_eq!(layout.max_lane, 0);
        assert!(layout.rows.iter().all(|row| row.passing.is_empty()));
        assert_trunk_owns_lane_zero(&layout, &trunk);
    }

    #[test]
    fn a_branch_and_its_merge_use_one_extra_lane() {
        //   m      マージ
        //   |\
        //   c |    幹
        //   | b    枝
        //   |/
        //   a      ルート
        let (trunk, layout) = layout_of(&[
            ("m", &["c", "b"]),
            ("c", &["a"]),
            ("b", &["a"]),
            ("a", &[]),
        ]);

        assert_eq!(lanes(&layout), [0, 0, 1, 0]);
        assert_eq!(layout.max_lane, 1);
        assert_trunk_owns_lane_zero(&layout, &trunk);

        // 第 2 親は右へ新レーンを起こす。
        let m = row(&layout, "m");
        assert_eq!(m.edges[0].to_lane, 0);
        assert!(!m.edges[0].is_merge_second_parent);
        assert_eq!(m.edges[1].to_lane, 1);
        assert!(m.edges[1].is_merge_second_parent);

        // 枝は幹の行を素通りし、ルートで合流して消える。
        assert_eq!(row(&layout, "c").passing, [1]);
        assert_eq!(row(&layout, "b").passing, [0]);
        assert!(row(&layout, "a").passing.is_empty());
    }

    #[test]
    fn consecutive_merges_open_one_lane_each() {
        //   m1     マージ（親: m2, y）
        //   m2     マージ（親: c, x）
        let (trunk, layout) = layout_of(&[
            ("m1", &["m2", "y"]),
            ("m2", &["c", "x"]),
            ("y", &["c"]),
            ("x", &["c"]),
            ("c", &[]),
        ]);

        assert_trunk_owns_lane_zero(&layout, &trunk);
        // 幹は m1 -> m2 -> c。枝 2 本がそれぞれ別のレーンに乗る。
        assert_eq!(lanes(&layout), [0, 0, 1, 2, 0]);
        assert_eq!(layout.max_lane, 2);
    }

    #[test]
    fn octopus_merge_opens_one_lane_per_extra_parent() {
        let (trunk, layout) = layout_of(&[
            ("o", &["a", "b", "c"]),
            ("a", &["r"]),
            ("b", &["r"]),
            ("c", &["r"]),
            ("r", &[]),
        ]);

        assert_eq!(lanes(&layout), [0, 0, 1, 2, 0]);
        assert_eq!(layout.max_lane, 2);
        assert_trunk_owns_lane_zero(&layout, &trunk);

        let o = row(&layout, "o");
        assert_eq!(o.edges.len(), 3);
        assert_eq!(
            o.edges.iter().map(|edge| edge.to_lane).collect::<Vec<_>>(),
            [0, 1, 2]
        );
        assert!(o.edges[1].is_merge_second_parent && o.edges[2].is_merge_second_parent);

        // 3 本の枝はルートで一度に合流する。
        assert!(row(&layout, "r").passing.is_empty());
    }

    #[test]
    fn two_roots_each_end_their_lane() {
        //   m      2 つの無関係な履歴の合流
        //   |\
        //   a r2
        //   |
        //   r1
        let (trunk, layout) = layout_of(&[
            ("m", &["a", "r2"]),
            ("a", &["r1"]),
            ("r2", &[]),
            ("r1", &[]),
        ]);

        assert_eq!(lanes(&layout), [0, 0, 1, 0]);
        assert_trunk_owns_lane_zero(&layout, &trunk);

        // ルートで終わったレーンは以降 passing に出ない。
        assert!(row(&layout, "r1").passing.is_empty());
    }

    #[test]
    fn a_freed_lane_is_not_reused_immediately() {
        // b がルートで lane 1 を解放した直後に、別の枝先端 d が現れる。
        // 解放直後の RESERVE_ROWS 行は再利用しないので lane 2 に乗る。
        let (_, layout) = layout_of(&[
            ("m", &["a", "b"]),
            ("a", &["r"]),
            ("b", &[]),
            ("d", &["r"]),
            ("r", &[]),
        ]);

        assert_eq!(row(&layout, "b").lane, 1);
        assert_eq!(row(&layout, "d").lane, 2, "解放直後のレーンを再利用している");
        assert_eq!(RESERVE_ROWS, 2);
    }

    #[test]
    fn a_freed_lane_is_reused_after_the_reserve() {
        let (_, layout) = layout_of(&[
            ("m", &["a", "b"]),
            ("a", &["a2"]),
            ("b", &[]),
            ("a2", &["a3"]),
            ("a3", &["r"]),
            ("d", &["r"]),
            ("r", &[]),
        ]);

        assert_eq!(row(&layout, "b").lane, 1);
        // b の解放は 3 行目、d は 6 行目。保留は 2 行なので再利用できる。
        assert_eq!(row(&layout, "d").lane, 1);
    }

    #[test]
    fn trunk_follows_first_parents_only() {
        let commits = dag(&[("m", &["c", "b"]), ("c", &["a"]), ("b", &["a"]), ("a", &[])]);
        let trunk = trunk_chain(&commits, Some("m"));

        assert_eq!(
            trunk,
            ["m", "c", "a"].map(String::from).into_iter().collect()
        );
    }

    #[test]
    fn trunk_falls_back_to_the_first_commit() {
        let commits = dag(&[("b", &["a"]), ("a", &[])]);

        // 幹が決まらない（detached ＋ main/master 無し）。
        assert_eq!(trunk_chain(&commits, None).len(), 2);
        // 起点がグラフ外を指す（読み込んだ集合に無い SHA）。
        assert_eq!(trunk_chain(&commits, Some("zzz")).len(), 2);
        // コミットが無ければ幹も無い。
        assert!(trunk_chain(&[], None).is_empty());
    }

    #[test]
    fn trunk_start_resolves_the_ref_name_to_a_sha() {
        let refs = vec![
            RefEntry {
                name: "refs/heads/main".to_string(),
                short_name: "main".to_string(),
                kind: RefKind::LocalBranch,
                target: "aaa".to_string(),
                upstream: None,
                out_of_graph: false,
            },
            RefEntry {
                name: "refs/remotes/origin/main".to_string(),
                short_name: "origin/main".to_string(),
                kind: RefKind::RemoteBranch,
                target: "bbb".to_string(),
                upstream: None,
                out_of_graph: false,
            },
        ];

        // 短縮名が同じ 2 つを取り違えない。
        assert_eq!(
            trunk_start(&refs, Some("refs/remotes/origin/main")),
            Some("bbb")
        );
        assert_eq!(trunk_start(&refs, Some("refs/heads/main")), Some("aaa"));
        assert_eq!(trunk_start(&refs, Some("refs/heads/nope")), None);
        assert_eq!(trunk_start(&refs, None), None);
    }

    #[test]
    fn trunk_chain_survives_a_cycle() {
        // git には無い形だが、壊れた入力で無限ループにしない。
        let commits = vec![commit_at("a", &["b"], 2), commit_at("b", &["a"], 1)];
        assert_eq!(trunk_chain(&commits, Some("a")).len(), 2);
    }

    #[test]
    fn every_fixture_keeps_lane_zero_for_the_trunk() {
        let fixtures: [&[(&str, &[&str])]; 6] = [
            &[("c", &["b"]), ("b", &["a"]), ("a", &[])],
            &[("m", &["c", "b"]), ("c", &["a"]), ("b", &["a"]), ("a", &[])],
            &[
                ("m1", &["m2", "y"]),
                ("m2", &["c", "x"]),
                ("y", &["c"]),
                ("x", &["c"]),
                ("c", &[]),
            ],
            &[
                ("o", &["a", "b", "c"]),
                ("a", &["r"]),
                ("b", &["r"]),
                ("c", &["r"]),
                ("r", &[]),
            ],
            &[("m", &["a", "r2"]), ("a", &["r1"]), ("r2", &[]), ("r1", &[])],
            &[("a", &[])],
        ];

        for spec in fixtures {
            let (trunk, layout) = layout_of(spec);
            assert_trunk_owns_lane_zero(&layout, &trunk);
            assert!(layout.rows.iter().all(|row| row.lane <= layout.max_lane));
        }
    }
}
