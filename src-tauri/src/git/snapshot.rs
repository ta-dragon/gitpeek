//! リポジトリ 1 つ分のグラフ素材をまとめて読み、LRU で保持する。
//!
//! 呼ぶ git は 3 つだけ（[`super::repo::read_head`] の 2 つを含めて 4 プロセス）。
//! ブランチごとに `rev-list --count` を回すような実装にはしない（docs/DESIGN.md §4.5）。
//!
//! **キャッシュの無効化は ref の指紋で判定する。** ref 一覧の取得は数 ms で終わるので、
//! 「毎回 ref だけ引いて、変わっていなければ `git log` を省く」という形にしている。

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::commandlog::LogSink;
use crate::git::progress::{LoadPhase, Reporting};
use crate::git::repo::HeadState;
use crate::git::{log as gitlog, refs, repo};
use crate::model::{HeadInfo, RepositorySnapshot};

/// 保持するスナップショットの数（docs/DESIGN.md §6.2）。
///
/// 数万コミット × この数だけメモリに載る。切替を体感即時にするのが目的なので、
/// 「直前に見ていた 2 つ」に届けば十分。
pub const CACHE_CAPACITY: usize = 3;

/// キャッシュを見てから読む。`force` を立てると指紋が一致していても読み直す。
///
/// `Arc` で返すのは、**キャッシュへの格納と呼び出し元への返却で 2 部持たないため**。
/// 数万コミットなら誤差だが、100 万コミット級では丸ごとの複製が実測 0.8 秒かかる。
pub fn load_cached(
    log: &dyn LogSink,
    program: &str,
    path: &Path,
    cache: &SnapshotCache,
    id: &str,
    force: bool,
    reporting: &Reporting<'_>,
) -> Result<Arc<RepositorySnapshot>, String> {
    reporting.report(LoadPhase::Refs, 0);

    let head = head_info(repo::read_head(log, program, path));
    let refs = refs::load(log, program, path)?;
    let fingerprint = refs::fingerprint(&refs.entries, &head);

    if !force {
        if let Some(cached) = cache.get(id, &fingerprint) {
            return Ok(cached);
        }
    }

    let snapshot = Arc::new(assemble(log, program, path, head, refs, fingerprint, reporting)?);
    cache.store(id, Arc::clone(&snapshot));
    Ok(snapshot)
}

/// キャッシュも途中経過も通さずに読む。テスト用。
pub fn load(log: &dyn LogSink, program: &str, path: &Path) -> Result<RepositorySnapshot, String> {
    let head = head_info(repo::read_head(log, program, path));
    let refs = refs::load(log, program, path)?;
    let fingerprint = refs::fingerprint(&refs.entries, &head);
    assemble(
        log,
        program,
        path,
        head,
        refs,
        fingerprint,
        &Reporting::silent(),
    )
}

fn assemble(
    log: &dyn LogSink,
    program: &str,
    path: &Path,
    head: HeadInfo,
    mut refs: refs::Refs,
    fingerprint: String,
    reporting: &Reporting<'_>,
) -> Result<RepositorySnapshot, String> {
    // コミット 0 件のリポジトリに `HEAD` を渡すと git log 全体が失敗する。
    let commits = gitlog::load(log, program, path, head.sha.is_some(), reporting)?;

    reporting.report(LoadPhase::Graph, commits.len() as u64);

    let reachable: HashSet<&str> = commits.iter().map(|commit| commit.sha.as_str()).collect();
    refs::mark_out_of_graph(&mut refs.entries, &reachable);
    let default_branch = refs::default_branch(&refs, &head);

    // orphan 判定は幹の島がどれかを決めてからでないとできない。
    let anchor = crate::graph::lane::trunk_start(&refs.entries, default_branch.as_deref());
    let disconnected = crate::graph::component::disconnected_from(&commits, anchor);
    refs::mark_orphans(&mut refs.entries, &disconnected);

    Ok(RepositorySnapshot {
        commits,
        refs: refs.entries,
        head,
        default_branch,
        loaded_at: chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        ref_fingerprint: fingerprint,
    })
}

/// 一覧表示用の [`HeadState`] を、グラフ用の平らな [`HeadInfo`] に直す。
///
/// `None`（どちらの git も失敗した）は「HEAD が読めない」であって unborn ではない。
/// unborn と混同すると空リポジトリ扱いになり、実在するブランチが消える。
fn head_info(state: Option<HeadState>) -> HeadInfo {
    match state {
        Some(HeadState::Branch { name, sha }) => HeadInfo {
            sha: Some(sha),
            branch: Some(name),
            detached: false,
            unborn: false,
        },
        Some(HeadState::Detached { sha }) => HeadInfo {
            sha: Some(sha),
            branch: None,
            detached: true,
            unborn: false,
        },
        Some(HeadState::Unborn { name }) => HeadInfo {
            sha: None,
            branch: Some(name),
            detached: false,
            unborn: true,
        },
        None => HeadInfo {
            sha: None,
            branch: None,
            detached: false,
            unborn: false,
        },
    }
}

/// 直近に読んだスナップショットを数件だけ持つ LRU。
///
/// 件数が [`CACHE_CAPACITY`] しかないので `Vec` の線形探索で足りる。
/// `lru` クレートは入れない。
#[derive(Default)]
pub struct SnapshotCache {
    /// 先頭が最新。
    entries: Mutex<Vec<Cached>>,
}

struct Cached {
    id: String,
    snapshot: Arc<RepositorySnapshot>,
}

impl SnapshotCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// 指紋が一致するものだけ返す。返したものは最新として先頭へ移す。
    pub fn get(&self, id: &str, fingerprint: &str) -> Option<Arc<RepositorySnapshot>> {
        let mut entries = self.entries.lock().ok()?;
        let index = entries.iter().position(|cached| cached.id == id)?;

        // ref が動いていればキャッシュは古い。捨てて読み直させる。
        if entries[index].snapshot.ref_fingerprint != fingerprint {
            entries.remove(index);
            return None;
        }

        let cached = entries.remove(index);
        let snapshot = Arc::clone(&cached.snapshot);
        entries.insert(0, cached);
        Some(snapshot)
    }

    pub fn store(&self, id: &str, snapshot: Arc<RepositorySnapshot>) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        entries.retain(|cached| cached.id != id);
        entries.insert(
            0,
            Cached {
                id: id.to_string(),
                snapshot,
            },
        );
        entries.truncate(CACHE_CAPACITY);
    }

    /// 登録解除・パス再指定のときに捨てる。
    pub fn forget(&self, id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|cached| cached.id != id);
        }
    }

    #[cfg(test)]
    fn ids(&self) -> Vec<String> {
        self.entries
            .lock()
            .map(|entries| entries.iter().map(|cached| cached.id.clone()).collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::{head_info, SnapshotCache, CACHE_CAPACITY};
    use crate::git::repo::HeadState;
    use crate::model::{HeadInfo, RepositorySnapshot};
    use std::sync::Arc;

    fn snapshot(fingerprint: &str) -> Arc<RepositorySnapshot> {
        Arc::new(RepositorySnapshot {
            commits: Vec::new(),
            refs: Vec::new(),
            head: head_info(None),
            default_branch: None,
            loaded_at: "2026-09-02T00:00:00.000+09:00".to_string(),
            ref_fingerprint: fingerprint.to_string(),
        })
    }

    #[test]
    fn flattens_the_three_head_states() {
        assert_eq!(
            head_info(Some(HeadState::Branch {
                name: "main".to_string(),
                sha: "abc".to_string(),
            })),
            HeadInfo {
                sha: Some("abc".to_string()),
                branch: Some("main".to_string()),
                detached: false,
                unborn: false,
            }
        );

        let detached = head_info(Some(HeadState::Detached {
            sha: "abc".to_string(),
        }));
        assert!(detached.detached && !detached.unborn && detached.branch.is_none());

        let unborn = head_info(Some(HeadState::Unborn {
            name: "main".to_string(),
        }));
        assert!(unborn.unborn && unborn.sha.is_none());

        // HEAD が読めないのは unborn ではない。
        let unknown = head_info(None);
        assert!(!unknown.unborn && !unknown.detached && unknown.sha.is_none());
    }

    #[test]
    fn returns_a_snapshot_only_while_the_fingerprint_matches() {
        let cache = SnapshotCache::new();
        cache.store("a", snapshot("f1"));

        assert!(cache.get("a", "f1").is_some());
        // ref が動いたら捨てる。
        assert!(cache.get("a", "f2").is_none());
        assert!(cache.get("a", "f1").is_none());
    }

    #[test]
    fn keeps_only_the_most_recent_repositories() {
        let cache = SnapshotCache::new();
        for id in ["a", "b", "c", "d"] {
            cache.store(id, snapshot("f"));
        }
        assert_eq!(cache.ids().len(), CACHE_CAPACITY);
        // 最初に入れたものが押し出される。
        assert!(cache.get("a", "f").is_none());
        assert!(cache.get("d", "f").is_some());
    }

    #[test]
    fn moves_a_hit_to_the_front() {
        let cache = SnapshotCache::new();
        for id in ["a", "b", "c"] {
            cache.store(id, snapshot("f"));
        }
        // 触ったものは押し出されない。
        assert!(cache.get("a", "f").is_some());
        cache.store("d", snapshot("f"));
        assert!(cache.get("a", "f").is_some());
        assert!(cache.get("b", "f").is_none());
    }

    #[test]
    fn forgets_on_demand() {
        let cache = SnapshotCache::new();
        cache.store("a", snapshot("f"));
        cache.forget("a");
        assert!(cache.get("a", "f").is_none());
    }
}
