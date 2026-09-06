//! 到達可能性と ahead/behind（T-09）を生成済みリポジトリに対して通す結合テスト。
//!
//! 形ごとの期待値は `src/graph/reach.rs` のユニットテスト側で見る。
//! ここで見るのは「**実物の履歴で git 自身の答えと一致する**」ことと、
//! 「可視 ref を絞るとグラフが実際に減る」こと。

mod common;

use std::collections::HashSet;
use std::process::Command;

use gitpeek_lib::git::snapshot;
use gitpeek_lib::graph::reach::{all_branch_status, CommitIndex};
use gitpeek_lib::graph::{self, GraphOrder};
use gitpeek_lib::model::RepositorySnapshot;
use gitpeek_lib::store::settings::VisibleRefs;

use common::{fixtures, log};

fn snapshot_of(name: &str) -> RepositorySnapshot {
    snapshot::load(&log(), "git", &fixtures().join(name))
        .unwrap_or_else(|error| panic!("{name} を読めません: {error}"))
}

/// 検証のためだけに git を呼ぶ。**アプリ本体からは呼ばない**（CLAUDE.md §2）。
fn rev_list_count(repo: &str, range: &str) -> u32 {
    let output = Command::new("git")
        .arg("-C")
        .arg(fixtures().join(repo))
        .args(["rev-list", "--count", range])
        .output()
        .expect("git rev-list を実行できません");
    assert!(output.status.success(), "git rev-list --count {range} が失敗");
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .expect("件数が数値でない")
}

fn hide(names: &[&str]) -> VisibleRefs {
    VisibleRefs {
        mode: "custom".to_string(),
        excluded: names.iter().map(|name| name.to_string()).collect(),
    }
}

fn shas(layout: &graph::LaneLayout) -> HashSet<&str> {
    layout.rows.iter().map(|row| row.sha.as_str()).collect()
}

#[test]
fn ahead_behind_matches_git_rev_list() {
    let snapshot = snapshot_of("diverged");
    let index = CommitIndex::new(&snapshot.commits);

    let target = |name: &str| {
        snapshot
            .refs
            .iter()
            .find(|entry| entry.name == name)
            .unwrap_or_else(|| panic!("{name} が無い"))
            .target
            .clone()
    };
    let main = target("refs/heads/main");
    let upstream = target("refs/remotes/origin/main");

    let (ahead, behind) = index.ahead_behind(&main, &upstream).expect("両方あるはず");

    assert_eq!(ahead, rev_list_count("diverged", "origin/main..main"));
    assert_eq!(behind, rev_list_count("diverged", "main..origin/main"));
    // 生成スクリプトが意図どおりに分岐させていることも押さえる。
    assert_eq!((ahead, behind), (2, 3));
}

#[test]
fn branch_status_reports_the_upstream_difference() {
    let snapshot = snapshot_of("diverged");
    let status = all_branch_status(&snapshot);

    assert_eq!(status.len(), 1, "上流を持つローカルブランチは main だけ");
    assert_eq!(status[0].ref_name, "refs/heads/main");
    assert_eq!(status[0].upstream, "refs/remotes/origin/main");
    assert_eq!((status[0].ahead, status[0].behind), (2, 3));
}

/// 上流に追いついているクローンでは 0 / 0。
#[test]
fn branch_status_is_zero_when_in_sync() {
    let snapshot = snapshot_of("cloned");
    let status = all_branch_status(&snapshot);

    assert_eq!(status.len(), 1);
    assert_eq!((status[0].ahead, status[0].behind), (0, 0));
}

/// ブランチを 1 本外すと、そのブランチにしか無いコミットだけが消える。
#[test]
fn hiding_a_branch_removes_only_its_own_commits() {
    let snapshot = snapshot_of("orphan");
    let all = graph::layout(&snapshot, &VisibleRefs::default(), GraphOrder::Topo);
    let hidden = graph::layout(
        &snapshot,
        &hide(&["refs/heads/assets"]),
        GraphOrder::Topo,
    );

    let removed: Vec<&str> = shas(&all).difference(&shas(&hidden)).copied().collect();
    assert_eq!(removed.len(), 2, "orphan ブランチの 2 件だけが消えること");

    // 消えたのが assets 側であることを、件名で確かめる。
    for sha in removed {
        let commit = snapshot
            .commits
            .iter()
            .find(|commit| commit.sha == sha)
            .expect("消えたコミットは元の集合にいる");
        assert!(
            commit.subject.starts_with("orphan の"),
            "幹のコミットが消えている: {}",
            commit.subject
        );
    }
}

/// マージ済みのブランチを外しても、幹から辿れるので 1 件も減らない。
#[test]
fn hiding_a_merged_branch_removes_nothing() {
    let snapshot = snapshot_of("branch-merge");
    let all = graph::layout(&snapshot, &VisibleRefs::default(), GraphOrder::Topo);
    let hidden = graph::layout(&snapshot, &hide(&["refs/heads/feature"]), GraphOrder::Topo);

    assert_eq!(shas(&all), shas(&hidden));
}

/// タグは起点 ref ではないので、外してもグラフは変わらない（CLAUDE.md §2）。
#[test]
fn hiding_a_tag_changes_nothing() {
    let snapshot = snapshot_of("tags");
    let all = graph::layout(&snapshot, &VisibleRefs::default(), GraphOrder::Topo);
    let hidden = graph::layout(&snapshot, &hide(&["refs/tags/v1.0"]), GraphOrder::Topo);

    assert_eq!(shas(&all), shas(&hidden));
}

/// 全部のチェックを外しても HEAD の履歴は残り、幹は lane 0 を通る。
#[test]
fn hiding_every_branch_keeps_head_and_lane_zero() {
    let snapshot = snapshot_of("orphan");
    let every: Vec<&str> = snapshot
        .refs
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    let layout = graph::layout(&snapshot, &hide(&every), GraphOrder::Topo);

    assert!(!layout.rows.is_empty(), "HEAD の履歴まで消えている");
    assert_eq!(layout.max_lane, 0, "HEAD の一直線だけが残るはず");
    assert!(layout.rows.iter().all(|row| row.lane == 0));
}

/// 幹の ref を隠しても lane 0 は空にしない（CLAUDE.md §3-1）。
#[test]
fn lane_zero_stays_occupied_when_the_trunk_is_hidden() {
    let snapshot = snapshot_of("orphan");
    // HEAD も main なので、main を隠しても HEAD 経由で残る。残ったうえで
    // lane 0 が空かないことを見る。
    let layout = graph::layout(&snapshot, &hide(&["refs/heads/main"]), GraphOrder::Topo);

    assert!(layout.rows.iter().any(|row| row.lane == 0));
}

/// 数万コミット規模でレーン計算が実用的な速さで終わること。
///
/// ベンチではないので閾値は緩く取り、実測値は出力に残す。
#[test]
fn layout_of_a_large_history_is_fast_enough() {
    const COMMITS: usize = 50_000;
    let mut commits = Vec::with_capacity(COMMITS);
    for i in 0..COMMITS {
        // 20 行おきに枝を 1 本生やしてマージする。線が 1 本だけの入力にしない。
        let sha = format!("{i:040x}");
        let parents = if i + 1 >= COMMITS {
            vec![]
        } else if i % 20 == 0 && i + 5 < COMMITS {
            vec![format!("{:040x}", i + 1), format!("{:040x}", i + 5)]
        } else {
            vec![format!("{:040x}", i + 1)]
        };
        commits.push(gitpeek_lib::model::CommitMeta {
            sha,
            short_sha: format!("{i:x}"),
            parents,
            author_name: "GitPeek Test".into(),
            author_email: "test@example.invalid".into(),
            author_time: 1_750_000_000 - i as i64,
            commit_time: 1_750_000_000 - i as i64,
            subject: format!("変更 {i}"),
        });
    }

    let tip = commits[0].sha.clone();
    let snapshot = RepositorySnapshot {
        commits,
        refs: vec![gitpeek_lib::model::RefEntry {
            name: "refs/heads/main".into(),
            short_name: "main".into(),
            kind: gitpeek_lib::model::RefKind::LocalBranch,
            target: tip.clone(),
            upstream: None,
            out_of_graph: false,
            orphan: false,
        }],
        head: gitpeek_lib::model::HeadInfo {
            sha: Some(tip),
            branch: Some("refs/heads/main".into()),
            detached: false,
            unborn: false,
        },
        default_branch: Some("refs/heads/main".into()),
        loaded_at: String::new(),
        ref_fingerprint: String::new(),
    };

    let started = std::time::Instant::now();
    let layout = graph::layout(&snapshot, &VisibleRefs::default(), GraphOrder::Topo);
    let all = started.elapsed();
    assert_eq!(layout.rows.len(), COMMITS);

    // 絞り込みのある経路。到達可能集合を作り、コミットを複製してから振り直す。
    let started = std::time::Instant::now();
    let filtered = graph::layout(&snapshot, &hide(&["refs/heads/gone"]), GraphOrder::Topo);
    let custom = started.elapsed();
    assert_eq!(filtered.rows.len(), COMMITS);

    println!("{COMMITS} コミットのレーン計算: 全表示 {all:?} / 絞り込みあり {custom:?}");
    assert!(
        all < std::time::Duration::from_secs(2) && custom < std::time::Duration::from_secs(2),
        "レーン計算が遅すぎる: 全表示 {all:?} / 絞り込みあり {custom:?}"
    );
}
