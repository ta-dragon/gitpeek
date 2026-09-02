//! 並び順。topo-order 既定、date-order に切替可（docs/DESIGN.md §4.3）。
//!
//! **切替で `git log` を再実行しない。** 親子関係も日時もメモリにあるので、
//! 並べ替えとレーン再計算だけで済む。

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

use serde::Deserialize;

use crate::model::CommitMeta;

/// 表示順。値は `"topo"` / `"date"`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum GraphOrder {
    #[default]
    Topo,
    Date,
}

/// コミット日時の新しい順に並べ替える。**ただし親を子より前に出さない。**
///
/// 単純に `commit_time` で降順ソートしてはいけない。rebase や amend、時計のずれで
/// 親の方が新しい日時を持つことがあり、そうなると
/// [`super::lane::assign_lanes`] の前提（親は必ず後ろ）が崩れてレーンが漏れる。
/// git の `--date-order` と同じく「子を全部出し終えた親から、日時の新しい順に出す」。
pub fn by_date(commits: &[CommitMeta]) -> Vec<CommitMeta> {
    let index: HashMap<&str, usize> = commits
        .iter()
        .enumerate()
        .map(|(i, commit)| (commit.sha.as_str(), i))
        .collect();

    // まだ出していない子の数。0 になった時点で出せる。
    let mut pending = vec![0usize; commits.len()];
    for commit in commits {
        for parent in &commit.parents {
            if let Some(&i) = index.get(parent.as_str()) {
                pending[i] += 1;
            }
        }
    }

    // 同じ日時のときは元の並び（topo-order）を保つため、添字の小さい方を先に出す。
    let mut ready: BinaryHeap<(i64, Reverse<usize>)> = commits
        .iter()
        .enumerate()
        .filter(|(i, _)| pending[*i] == 0)
        .map(|(i, commit)| (commit.commit_time, Reverse(i)))
        .collect();

    let mut ordered = Vec::with_capacity(commits.len());
    let mut emitted = vec![false; commits.len()];

    while let Some((_, Reverse(i))) = ready.pop() {
        ordered.push(commits[i].clone());
        emitted[i] = true;

        for parent in &commits[i].parents {
            if let Some(&j) = index.get(parent.as_str()) {
                pending[j] -= 1;
                if pending[j] == 0 {
                    ready.push((commits[j].commit_time, Reverse(j)));
                }
            }
        }
    }

    // git の履歴に循環は無いが、ここで行を落とすと画面からコミットが消える。
    // 万一取り残しが出たら元の順で後ろに付ける。
    if ordered.len() != commits.len() {
        ordered.extend(
            commits
                .iter()
                .enumerate()
                .filter(|(i, _)| !emitted[*i])
                .map(|(_, commit)| commit.clone()),
        );
    }

    ordered
}

#[cfg(test)]
mod tests {
    use super::by_date;
    use crate::graph::lane::tests::commit_at;

    fn shas(commits: &[crate::model::CommitMeta]) -> Vec<&str> {
        commits.iter().map(|c| c.sha.as_str()).collect()
    }

    #[test]
    fn orders_independent_commits_by_time() {
        // 2 本の独立した枝。日時の新しい順に混ざる。
        let commits = vec![
            commit_at("b", &["r"], 30),
            commit_at("a", &["r"], 40),
            commit_at("r", &[], 10),
        ];

        assert_eq!(shas(&by_date(&commits)), ["a", "b", "r"]);
    }

    #[test]
    fn never_puts_a_parent_before_its_child() {
        // 親 `p` の方が子 `c` より新しい（rebase や時計のずれで起きる）。
        let commits = vec![commit_at("c", &["p"], 10), commit_at("p", &[], 90)];

        assert_eq!(shas(&by_date(&commits)), ["c", "p"]);
    }

    #[test]
    fn keeps_topo_order_when_times_tie() {
        let commits = vec![
            commit_at("b", &["r"], 20),
            commit_at("a", &["r"], 20),
            commit_at("r", &[], 10),
        ];

        assert_eq!(shas(&by_date(&commits)), ["b", "a", "r"]);
    }

    #[test]
    fn handles_empty_input() {
        assert!(by_date(&[]).is_empty());
    }
}
