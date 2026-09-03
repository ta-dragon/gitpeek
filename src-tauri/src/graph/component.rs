//! コミット DAG の連結成分。**orphan ブランチを見分けるためだけに使う。**
//!
//! `git checkout --orphan` で作った履歴は、幹とコミットを 1 つも共有しない独立した島になる。
//! 島の根はルートコミット（親なし）なので、グラフ上ではそこで線が止まる。
//! 止まっただけなのか壊れているのかは見ただけでは分からないので、ref に印を付ける（T-27）。
//!
//! ここは**到達可能性ではない**（T-09 の [`super`] 配下に入る `reach` とは別物）。
//! 親子の向きを無視した無向グラフの連結成分なので、union-find 1 回で終わる。

use std::collections::{HashMap, HashSet};

use crate::model::CommitMeta;

/// `anchor` と繋がっていないコミットの SHA 集合。
///
/// `anchor` が無い / 読み込んだ集合に無いときは**先頭コミット**を使う。
/// 島が 1 つしか無い普通のリポジトリでは空集合が返る。
pub fn disconnected_from(commits: &[CommitMeta], anchor: Option<&str>) -> HashSet<String> {
    if commits.is_empty() {
        return HashSet::new();
    }

    let index: HashMap<&str, usize> = commits
        .iter()
        .enumerate()
        .map(|(i, commit)| (commit.sha.as_str(), i))
        .collect();

    let mut parent: Vec<usize> = (0..commits.len()).collect();
    for (i, commit) in commits.iter().enumerate() {
        for sha in &commit.parents {
            // 読み込んだ集合の外に出る親は繋がない（浅いクローンなど）。
            if let Some(&other) = index.get(sha.as_str()) {
                union(&mut parent, i, other);
            }
        }
    }

    let start = anchor
        .and_then(|sha| index.get(sha).copied())
        .unwrap_or(0);
    let island = find(&mut parent, start);

    commits
        .iter()
        .enumerate()
        .filter(|(i, _)| find(&mut parent, *i) != island)
        .map(|(_, commit)| commit.sha.clone())
        .collect()
}

fn find(parent: &mut [usize], mut node: usize) -> usize {
    while parent[node] != node {
        // 経路圧縮。深さが 100 万を超えても再帰しない。
        parent[node] = parent[parent[node]];
        node = parent[node];
    }
    node
}

fn union(parent: &mut [usize], a: usize, b: usize) {
    let (ra, rb) = (find(parent, a), find(parent, b));
    if ra != rb {
        parent[ra.max(rb)] = ra.min(rb);
    }
}

#[cfg(test)]
mod tests {
    use super::disconnected_from;
    use crate::model::CommitMeta;

    fn dag(spec: &[(&str, &[&str])]) -> Vec<CommitMeta> {
        spec.iter()
            .map(|(sha, parents)| CommitMeta {
                sha: (*sha).into(),
                short_sha: (*sha).into(),
                parents: parents.iter().map(|p| (*p).to_string()).collect(),
                author_name: String::new(),
                author_email: String::new(),
                author_time: 0,
                commit_time: 0,
                subject: String::new(),
            })
            .collect()
    }

    #[test]
    fn one_island_leaves_nothing_disconnected() {
        let commits = dag(&[("c", &["b"]), ("b", &["a"]), ("a", &[])]);
        assert!(disconnected_from(&commits, Some("c")).is_empty());
    }

    #[test]
    fn a_separate_island_is_reported() {
        //   c        o2      幹（c-b-a）と orphan（o2-o1）
        //   |        |
        //   b        o1
        //   |
        //   a
        let commits = dag(&[
            ("c", &["b"]),
            ("o2", &["o1"]),
            ("b", &["a"]),
            ("o1", &[]),
            ("a", &[]),
        ]);
        let found = disconnected_from(&commits, Some("c"));

        assert_eq!(found, ["o2", "o1"].map(String::from).into_iter().collect());
    }

    /// マージで後から繋がった島は独立ではない。
    #[test]
    fn an_island_merged_into_the_trunk_is_connected() {
        let commits = dag(&[
            ("m", &["b", "o1"]),
            ("b", &["a"]),
            ("o1", &[]),
            ("a", &[]),
        ]);
        assert!(disconnected_from(&commits, Some("m")).is_empty());
    }

    /// 幹の起点が分からないときは先頭コミットの島を幹とみなす。
    #[test]
    fn falls_back_to_the_first_commit() {
        let commits = dag(&[("c", &["b"]), ("b", &[]), ("o", &[])]);
        assert_eq!(
            disconnected_from(&commits, None),
            ["o"].map(String::from).into_iter().collect()
        );
    }

    #[test]
    fn empty_input_is_empty() {
        assert!(disconnected_from(&[], None).is_empty());
    }
}
