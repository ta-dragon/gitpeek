//! 到達可能性と ahead/behind。**git を追加で呼ばずにメモリ上のグラフから求める**
//! （CLAUDE.md §2 / docs/DESIGN.md §4.5）。
//!
//! `git rev-list --count` をブランチ数だけ呼ぶと、100 ブランチで 100 プロセス起動になる。
//! 全コミットの親子関係は既に手元にあるので、辿れば済む。
//!
//! [`super::component`]（orphan 判定）とは別物であることに注意。あちらは**向きを無視した
//! 連結成分**、こちらは**親方向へ辿る到達可能性**で、必要な答えも計算量も違う。

use std::collections::{BinaryHeap, HashMap, HashSet};

use serde::Serialize;

use crate::model::{CommitMeta, RefKind, RepositorySnapshot};

/// ブランチ 1 本の上流との差。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStatus {
    /// 完全な ref 名（`refs/heads/main`）。
    pub ref_name: String,
    /// 比べた相手（上流）の完全な ref 名。
    pub upstream: String,
    /// 上流に無くてこちらにあるコミット数（`git rev-list --count upstream..branch`）。
    pub ahead: u32,
    /// こちらに無くて上流にあるコミット数（その逆）。
    pub behind: u32,
}

/// コミット列に SHA → 添字の索引を添えたもの。
///
/// **`commits` は topo-order（親が必ず後ろ）であること。** 添字の大小がそのまま
/// 「子 < 親」になるので、[`Self::ahead_behind`] は最小添字から取り出すだけで
/// 「子を全部見てから親を見る」順序になる。
pub struct CommitIndex<'a> {
    commits: &'a [CommitMeta],
    by_sha: HashMap<&'a str, usize>,
}

/// [`CommitIndex::ahead_behind`] の印。
const SIDE_A: u8 = 1;
const SIDE_B: u8 = 2;
const BOTH: u8 = SIDE_A | SIDE_B;

impl<'a> CommitIndex<'a> {
    pub fn new(commits: &'a [CommitMeta]) -> Self {
        Self {
            commits,
            by_sha: commits
                .iter()
                .enumerate()
                .map(|(i, commit)| (commit.sha.as_str(), i))
                .collect(),
        }
    }

    pub fn contains(&self, sha: &str) -> bool {
        self.by_sha.contains_key(sha)
    }

    /// `tips` から親を辿って届くコミット全部（`tips` 自身を含む）。
    ///
    /// 第一親・第二親を区別しない。**ブランチ表示 ON/OFF はこの集合の差**であり、
    /// 淡色化ではない（CLAUDE.md §3-7）。
    pub fn reachable_from(&self, tips: &[String]) -> HashSet<&'a str> {
        let mut seen: HashSet<&'a str> = HashSet::new();
        let mut stack: Vec<usize> = Vec::new();

        for tip in tips {
            if let Some(&i) = self.by_sha.get(tip.as_str()) {
                if seen.insert(self.commits[i].sha.as_str()) {
                    stack.push(i);
                }
            }
        }

        while let Some(i) = stack.pop() {
            for parent in &self.commits[i].parents {
                if let Some(&p) = self.by_sha.get(parent.as_str()) {
                    if seen.insert(self.commits[p].sha.as_str()) {
                        stack.push(p);
                    }
                }
            }
        }
        seen
    }

    /// `(ahead, behind)` = `(a にあって b に無い数, b にあって a に無い数)`。
    /// どちらかが手元のコミット集合に無ければ `None`。
    ///
    /// 両側から同時に親へ下り、**共通祖先に着いた時点で止める**。全体を舐めないので、
    /// 分岐が浅いほど速い（ふつうのブランチと上流の差は数コミット）。
    /// ref ごとにビットセットを持つ実装は 20,000 コミット × 数千 ref でメモリが厳しいので採らない。
    pub fn ahead_behind(&self, a: &str, b: &str) -> Option<(u32, u32)> {
        let ia = *self.by_sha.get(a)?;
        let ib = *self.by_sha.get(b)?;
        if ia == ib {
            return Some((0, 0));
        }

        // 印は疎（辿った範囲にしか付かない）なので、全長の Vec は取らない。
        let mut flags: HashMap<usize, u8> = HashMap::new();
        let mut queue: BinaryHeap<std::cmp::Reverse<usize>> = BinaryHeap::new();
        // まだ取り出していない「片側だけの印が付いた」コミットの数。0 になったら終わり。
        let mut exclusive = 0usize;

        flags.insert(ia, SIDE_A);
        queue.push(std::cmp::Reverse(ia));
        flags.insert(ib, SIDE_B);
        queue.push(std::cmp::Reverse(ib));
        exclusive += 2;

        let (mut ahead, mut behind) = (0u32, 0u32);

        while exclusive > 0 {
            let Some(std::cmp::Reverse(i)) = queue.pop() else {
                break;
            };
            // 添字は「子 < 親」なので、ここへ来た時点で印は確定している。
            let flag = flags[&i];
            match flag {
                SIDE_A => {
                    ahead += 1;
                    exclusive -= 1;
                }
                SIDE_B => {
                    behind += 1;
                    exclusive -= 1;
                }
                // 両側から届く＝共通祖先。数えないが、印は親へ伝える。
                _ => {}
            }

            for parent in &self.commits[i].parents {
                let Some(&p) = self.by_sha.get(parent.as_str()) else {
                    continue;
                };
                let entry = flags.entry(p).or_insert(0);
                let before = *entry;
                *entry |= flag;
                if before == 0 {
                    queue.push(std::cmp::Reverse(p));
                    if *entry != BOTH {
                        exclusive += 1;
                    }
                } else if before != BOTH && *entry == BOTH {
                    // 片側だけだったものが共通祖先に変わった。
                    exclusive -= 1;
                }
            }
        }

        Some((ahead, behind))
    }
}

/// 上流を持つローカルブランチ全部の ahead/behind。
///
/// 相手は **`git branch -vv` と同じく上流**にする。上流の無いブランチ、リモート追跡ブランチ、
/// タグは結果に入れない（比べる相手が決まらない）。
/// 索引は 1 度だけ作る。1 本ずつ [`CommitIndex::new`] を呼ぶと本数ぶん全件を舐め直すことになる。
pub fn all_branch_status(snapshot: &RepositorySnapshot) -> Vec<BranchStatus> {
    let index = CommitIndex::new(&snapshot.commits);
    let target = |name: &str| {
        snapshot
            .refs
            .iter()
            .find(|entry| entry.name == name)
            .map(|entry| entry.target.as_str())
    };

    snapshot
        .refs
        .iter()
        .filter(|entry| entry.kind == RefKind::LocalBranch && !entry.out_of_graph)
        .filter_map(|entry| {
            let upstream = entry.upstream.as_deref()?;
            // 上流が消えている（`git fetch --prune` の後など）ことがある。
            let other = target(upstream)?;
            let (ahead, behind) = index.ahead_behind(&entry.target, other)?;
            Some(BranchStatus {
                ref_name: entry.name.clone(),
                upstream: upstream.to_string(),
                ahead,
                behind,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{all_branch_status, CommitIndex};
    use crate::model::{CommitMeta, HeadInfo, RefEntry, RefKind, RepositorySnapshot};

    /// topo-order（親が必ず後ろ）で並べた DAG を作る。
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

    fn sorted(set: std::collections::HashSet<&str>) -> Vec<&str> {
        let mut list: Vec<&str> = set.into_iter().collect();
        list.sort_unstable();
        list
    }

    // a -- b -- base のあとに枝が 2 本。
    //   x2      y2
    //   |       |
    //   x1      y1
    //     \    /
    //      base
    fn forked() -> Vec<CommitMeta> {
        dag(&[
            ("x2", &["x1"]),
            ("y2", &["y1"]),
            ("x1", &["base"]),
            ("y1", &["base"]),
            ("base", &[]),
        ])
    }

    #[test]
    fn reachable_from_one_tip_follows_every_parent() {
        let commits = forked();
        let index = CommitIndex::new(&commits);

        assert_eq!(
            sorted(index.reachable_from(&["x2".to_string()])),
            ["base", "x1", "x2"]
        );
    }

    #[test]
    fn reachable_from_a_merge_follows_both_parents() {
        let commits = dag(&[("m", &["x1", "y1"]), ("x1", &["base"]), ("y1", &["base"]), ("base", &[])]);
        let index = CommitIndex::new(&commits);

        assert_eq!(
            sorted(index.reachable_from(&["m".to_string()])),
            ["base", "m", "x1", "y1"]
        );
    }

    /// ブランチを 1 本外すと、そのブランチだけのコミットが消える。
    #[test]
    fn dropping_a_tip_drops_only_its_own_commits() {
        let commits = forked();
        let index = CommitIndex::new(&commits);

        let both = index.reachable_from(&["x2".to_string(), "y2".to_string()]);
        let only_x = index.reachable_from(&["x2".to_string()]);

        assert_eq!(sorted(both), ["base", "x1", "x2", "y1", "y2"]);
        assert_eq!(sorted(only_x), ["base", "x1", "x2"]);
    }

    #[test]
    fn unknown_tips_are_ignored() {
        let commits = forked();
        let index = CommitIndex::new(&commits);

        assert!(index.reachable_from(&["zzz".to_string()]).is_empty());
        assert_eq!(
            sorted(index.reachable_from(&["zzz".to_string(), "x1".to_string()])),
            ["base", "x1"]
        );
    }

    #[test]
    fn ahead_behind_of_the_same_commit_is_zero() {
        let commits = forked();
        let index = CommitIndex::new(&commits);

        assert_eq!(index.ahead_behind("x2", "x2"), Some((0, 0)));
    }

    #[test]
    fn ahead_behind_counts_only_one_side_when_it_is_a_descendant() {
        // base -- x1 -- x2。x2 は base より 2 つ進んでいる。
        let commits = dag(&[("x2", &["x1"]), ("x1", &["base"]), ("base", &[])]);
        let index = CommitIndex::new(&commits);

        assert_eq!(index.ahead_behind("x2", "base"), Some((2, 0)));
        assert_eq!(index.ahead_behind("base", "x2"), Some((0, 2)));
    }

    #[test]
    fn ahead_behind_counts_both_sides_when_they_diverge() {
        let commits = forked();
        let index = CommitIndex::new(&commits);

        assert_eq!(index.ahead_behind("x2", "y2"), Some((2, 2)));
        assert_eq!(index.ahead_behind("y2", "x2"), Some((2, 2)));
    }

    /// 共通祖先が無い（orphan ブランチ同士）。全件を数えて終わる。
    #[test]
    fn ahead_behind_without_a_common_ancestor() {
        let commits = dag(&[("x1", &["x0"]), ("o1", &[]), ("x0", &[])]);
        let index = CommitIndex::new(&commits);

        assert_eq!(index.ahead_behind("x1", "o1"), Some((2, 1)));
    }

    /// マージで合流していれば、片側は 0 になる。
    #[test]
    fn ahead_behind_after_a_merge() {
        //   m        m は x1 と y1 の両方を含む
        //  / \
        // x1  y1
        //  \ /
        //  base
        let commits = dag(&[
            ("m", &["x1", "y1"]),
            ("x1", &["base"]),
            ("y1", &["base"]),
            ("base", &[]),
        ]);
        let index = CommitIndex::new(&commits);

        assert_eq!(index.ahead_behind("m", "y1"), Some((2, 0)));
        assert_eq!(index.ahead_behind("y1", "m"), Some((0, 2)));
    }

    #[test]
    fn ahead_behind_of_an_unknown_commit_is_none() {
        let commits = forked();
        let index = CommitIndex::new(&commits);

        assert_eq!(index.ahead_behind("x2", "zzz"), None);
        assert_eq!(index.ahead_behind("zzz", "x2"), None);
    }

    fn entry(name: &str, kind: RefKind, target: &str, upstream: Option<&str>) -> RefEntry {
        RefEntry {
            name: name.to_string(),
            short_name: name.to_string(),
            kind,
            target: target.to_string(),
            upstream: upstream.map(str::to_string),
            out_of_graph: false,
            orphan: false,
        }
    }

    fn snapshot_of(commits: Vec<CommitMeta>, refs: Vec<RefEntry>) -> RepositorySnapshot {
        RepositorySnapshot {
            commits,
            refs,
            head: HeadInfo {
                sha: None,
                branch: None,
                detached: false,
                unborn: false,
            },
            default_branch: None,
            loaded_at: String::new(),
            ref_fingerprint: String::new(),
        }
    }

    #[test]
    fn branch_status_compares_against_the_upstream_only() {
        let snapshot = snapshot_of(
            forked(),
            vec![
                entry(
                    "refs/heads/main",
                    RefKind::LocalBranch,
                    "x2",
                    Some("refs/remotes/origin/main"),
                ),
                entry("refs/remotes/origin/main", RefKind::RemoteBranch, "x1", None),
                // 上流の無いローカルブランチと、リモート追跡ブランチとタグは出さない。
                entry("refs/heads/topic", RefKind::LocalBranch, "y2", None),
                entry("refs/tags/v1", RefKind::Tag, "y1", None),
            ],
        );

        let status = all_branch_status(&snapshot);

        assert_eq!(status.len(), 1);
        assert_eq!(status[0].ref_name, "refs/heads/main");
        assert_eq!(status[0].upstream, "refs/remotes/origin/main");
        assert_eq!((status[0].ahead, status[0].behind), (1, 0));
    }

    /// `fetch --prune` の後など、上流の ref が消えていることがある。
    #[test]
    fn branch_status_skips_a_missing_upstream() {
        let snapshot = snapshot_of(
            forked(),
            vec![entry(
                "refs/heads/main",
                RefKind::LocalBranch,
                "x2",
                Some("refs/remotes/origin/gone"),
            )],
        );

        assert!(all_branch_status(&snapshot).is_empty());
    }
}
