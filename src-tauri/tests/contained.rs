//! ブランチが取り込まれているか（T-37）の結合テスト。
//!
//! 生成済みリポジトリ `squash`（`scripts/make-test-repos.sh`）に対して実際の git を走らせる。
//! 二分探索と差分の指紋そのものは `src/git/contained.rs` 側の単体テストが見ている。
//!
//! **ここで確かめたいのは 2 つ** — 5 種類の判定がそれぞれ当たること、そして
//! **判定の前後でリポジトリのオブジェクトが増えないこと**（CLAUDE.md §1 の 4 件目。
//! 書いてよいのは一時フォルダだけ）。

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;

use gitpeek_lib::git::contained::{self, Containment, ContainmentOutcome};
use gitpeek_lib::git::exec::Cancel;
use gitpeek_lib::git::snapshot;
use gitpeek_lib::model::RepositorySnapshot;

use common::{fixtures, log};

fn repo() -> PathBuf {
    fixtures().join("squash")
}

fn load() -> RepositorySnapshot {
    snapshot::load(&log(), "git", &repo()).expect("squash を読めること")
}

fn check_with(
    snapshot: &RepositorySnapshot,
    branch: &str,
    target: &str,
    scratch_parent: &Path,
) -> ContainmentOutcome {
    contained::check_in(
        &log(),
        "git",
        &repo(),
        snapshot,
        &format!("refs/heads/{branch}"),
        &format!("refs/heads/{target}"),
        scratch_parent,
    )
    .unwrap_or_else(|error| panic!("{branch} → {target} を調べられません: {error}"))
}

fn check(branch: &str, target: &str) -> Containment {
    let scratch = tempfile::tempdir().expect("一時ディレクトリ");
    check_with(&load(), branch, target, scratch.path()).containment
}

/// 要約から SHA を引く。**SHA を固定で書くと fixture を作り直すたびに変わる。**
fn sha_of(subject: &str) -> String {
    load()
        .commits
        .iter()
        .find(|commit| commit.subject == subject)
        .unwrap_or_else(|| panic!("要約 {subject:?} のコミットが無い"))
        .sha
        .clone()
}

#[test]
fn a_normally_merged_branch_is_an_ancestor() {
    assert_eq!(check("merged-normally", "main"), Containment::Ancestor);
}

#[test]
fn a_squashed_branch_is_contained_and_names_the_squash() {
    assert_eq!(
        check("squashed", "main"),
        Containment::Contained {
            squash: Some(sha_of("Squashed: squashed")),
        }
    );
}

#[test]
fn a_branch_that_grew_after_the_squash_is_partly_contained() {
    // 4 コミット中、squash された 3 つまでは入っている。
    assert_eq!(
        check("grown", "main"),
        Containment::Partial {
            upto: 3,
            total: 4,
            squash: Some(sha_of("Squashed: squashed")),
        }
    );
}

#[test]
fn a_squash_rewritten_afterwards_is_found_by_comparing_diffs() {
    // 相手で同じ行をさらに書き換えたので、仮にマージすると衝突する（③は外れる）。
    // 差分の突き合わせ（②）だけが squash を見つける。
    assert_eq!(
        check("squashed", "main-rewritten"),
        Containment::SquashedThenChanged {
            squash: sha_of("Squashed: squashed"),
        }
    );
}

#[test]
fn a_branch_taken_in_by_cherry_picks_is_contained_without_a_squash() {
    // 1 つずつ cherry-pick で取り込まれた。中身は入っているが、ブランチ全体と同じ変更を持つ
    // コミットは無い（③は当たり、②は外れる）。**squash を無理に指さない**こと。
    assert_eq!(
        check("picked", "main-picked"),
        Containment::Contained { squash: None }
    );
}

#[test]
fn a_decoy_touching_the_same_files_is_not_taken_for_the_squash() {
    // 相手の一番新しいコミットが、squash と**同じファイルの組**を触っている（中身は違う）。
    // ファイルの組だけで決めると、こちらを squash と取り違える。
    assert_eq!(
        check("squashed", "main-decoy"),
        Containment::SquashedThenChanged {
            squash: sha_of("Squashed: squashed"),
        }
    );
}

#[test]
fn a_branch_that_merged_the_target_midway_is_still_found() {
    // squash の前に相手を取り込んでいる（よくあるやり方）。分岐点がずれても、
    // 差分は取り込んだぶんを含まないので、squash と突き合わせられる。
    assert_eq!(
        check("refreshed", "main-refreshed"),
        Containment::Contained {
            squash: Some(sha_of("Squashed: refreshed")),
        }
    );
}

#[test]
fn an_unmerged_branch_is_not_contained() {
    assert_eq!(check("unmerged", "main"), Containment::NotContained);
}

#[test]
fn a_branch_with_unrelated_history_is_not_contained() {
    // merge-tree は「無関係な履歴」で断るので、走らせる前に決まること。
    assert_eq!(check("lonely", "main"), Containment::NotContained);
}

#[test]
fn the_outcome_carries_both_tips() {
    // 画面は「先端の組」で結果を覚える（T-38）。
    let snapshot = load();
    let scratch = tempfile::tempdir().expect("一時ディレクトリ");
    let outcome = check_with(&snapshot, "squashed", "main", scratch.path());
    let tip = |name: &str| {
        snapshot
            .refs
            .iter()
            .find(|entry| entry.name == name)
            .map(|entry| entry.target.clone())
            .expect("ref があること")
    };
    assert_eq!(outcome.branch_tip, tip("refs/heads/squashed"));
    assert_eq!(outcome.target_tip, tip("refs/heads/main"));
}

#[test]
fn a_tag_or_a_missing_branch_or_the_same_branch_is_refused() {
    let snapshot = load();
    let scratch = tempfile::tempdir().expect("一時ディレクトリ");
    let run = |branch: &str, target: &str| {
        contained::check_in(&log(), "git", &repo(), &snapshot, branch, target, scratch.path())
    };
    assert!(run("refs/heads/main", "refs/heads/main").is_err());
    assert!(run("refs/heads/nothing", "refs/heads/main").is_err());
    // タグは起点 ref ではないので、相手にも調べる対象にもしない。
    // **実在するタグ**で断られること（無いタグだと「見つからない」で緑になってしまう）。
    assert!(snapshot.refs.iter().any(|entry| entry.name == "refs/tags/squash-tag"));
    let refused = run("refs/heads/squashed", "refs/tags/squash-tag").expect_err("タグで断ること");
    assert!(refused.contains("squash-tag"), "{refused}");
}

/// **リポジトリへは書かない**（CLAUDE.md §1 の 4 件目）。
///
/// 未マージのブランチと途中まで入っているブランチは、仮のマージで**相手に無い tree** ができる。
/// 隔離していなければ、それがリポジトリの objects に書かれて数が増える。
/// **隔離の環境変数を外すとこのテストが落ちることを 1 度確かめてある**（DESIGN.md §7.6）。
#[test]
fn checking_writes_nothing_into_the_repository() {
    let before = loose_objects(&repo());
    let snapshot = load();
    let scratch = tempfile::tempdir().expect("一時ディレクトリ");
    for branch in ["unmerged", "grown", "squashed"] {
        check_with(&snapshot, branch, "main", scratch.path());
    }
    check_with(&snapshot, "squashed", "main-rewritten", scratch.path());
    assert_eq!(loose_objects(&repo()), before, "リポジトリにオブジェクトが書かれた");
}

/// **一時フォルダは残さない。** 判定が終われば、置き場所は空に戻る。
#[test]
fn the_scratch_folder_is_removed_afterwards() {
    let snapshot = load();
    let scratch = tempfile::tempdir().expect("一時ディレクトリ");
    for (branch, target) in [
        ("unmerged", "main"),
        ("grown", "main"),
        ("squashed", "main-rewritten"),
    ] {
        check_with(&snapshot, branch, target, scratch.path());
    }
    let left = std::fs::read_dir(scratch.path()).expect("読めること").count();
    assert_eq!(left, 0, "一時フォルダが残っている");
}

/// `git count-objects` の緩いオブジェクトの数。テストの中なので git を直接呼んでよい。
fn loose_objects(repo: &Path) -> u64 {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["count-objects", "-v"])
        .output()
        .expect("git を起動できること");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("count: "))
        .and_then(|count| count.trim().parse().ok())
        .expect("count: の行があること")
}

/* ---------- 取り込んでいる可能性があるブランチを探す（T-38）---------- */

fn names(list: &[String]) -> Vec<&str> {
    list.iter().map(String::as_str).collect()
}

#[test]
fn candidates_leave_out_what_cannot_be_a_container() {
    let snapshot = load();
    let candidates = contained::container_candidates(&snapshot, "refs/heads/squashed")
        .expect("候補を出せること");
    let listed = names(&candidates);

    // 取り込んでいるものも、いないものも候補には入る（調べてみないと分からない）。
    for name in ["refs/heads/main", "refs/heads/grown", "refs/heads/unmerged"] {
        assert!(listed.contains(&name), "{name} が候補に無い: {listed:?}");
    }
    // 自分自身・タグ・先端が古いもの・自分を上流にしているものは外す。
    for name in [
        "refs/heads/squashed",
        "refs/tags/squash-tag",
        "refs/heads/stale",
        "refs/heads/follows-squashed",
    ] {
        assert!(!listed.contains(&name), "{name} が候補に入っている: {listed:?}");
    }
    // **外した理由が別のものになっていないこと**: stale は中身を持っている（main から分かれた）ので、
    // 候補にすれば見つかる。外れたのは先端が古いからだけ。
    assert_eq!(
        check("squashed", "stale"),
        Containment::Contained {
            squash: Some(sha_of("Squashed: squashed")),
        }
    );
    assert_eq!(check("squashed", "follows-squashed"), Containment::Ancestor);

    // 逆向き: follows-squashed から見ると、上流の squashed は候補にしない。
    let reverse = contained::container_candidates(&snapshot, "refs/heads/follows-squashed")
        .expect("候補を出せること");
    assert!(!names(&reverse).contains(&"refs/heads/squashed"), "{reverse:?}");
    // 上流でなければ候補になる（外れたのが上流だからだと確かめる）。
    assert!(names(&reverse).contains(&"refs/heads/main"), "{reverse:?}");
}

#[test]
fn candidates_come_local_first_then_by_name() {
    let candidates =
        contained::container_candidates(&load(), "refs/heads/squashed").expect("候補を出せること");
    let mut sorted = candidates.clone();
    sorted.sort_by_key(|name| (!name.starts_with("refs/heads/"), name.clone()));
    assert_eq!(candidates, sorted);
}

#[test]
fn every_container_of_a_squashed_branch_is_found() {
    let snapshot = load();
    let scratch = tempfile::tempdir().expect("一時ディレクトリ");
    let mut calls = Vec::new();
    let search = contained::find_containers_in(
        &log(),
        "git",
        &repo(),
        &snapshot,
        "refs/heads/squashed",
        &Cancel::new(),
        &mut |done, total, found| calls.push((done, total, found)),
        scratch.path(),
    )
    .expect("調べられること");

    let found = |name: &str| {
        search
            .found
            .iter()
            .find(|outcome| outcome.target == name)
            .map(|outcome| outcome.containment.clone())
    };
    let squash = sha_of("Squashed: squashed");
    assert_eq!(
        found("refs/heads/main"),
        Some(Containment::Contained {
            squash: Some(squash.clone()),
        })
    );
    assert_eq!(found("refs/heads/grown"), Some(Containment::Ancestor));
    assert_eq!(
        found("refs/heads/main-rewritten"),
        Some(Containment::SquashedThenChanged { squash })
    );
    // 入っていないものは載せない。
    for name in ["refs/heads/unmerged", "refs/heads/merged-normally", "refs/heads/lonely"] {
        assert_eq!(found(name), None, "{name} が見つかったことになっている");
    }

    assert!(!search.cancelled);
    assert!(search.failures.is_empty(), "{:?}", search.failures);
    assert_eq!(search.checked, search.total);
    // 進み具合は 0 から始まり、1 本ごとに 1 つ進んで、最後は全部。
    assert_eq!(calls.first(), Some(&(0, search.total, 0)));
    assert_eq!(calls.len() as u32, search.total + 1);
    assert_eq!(
        calls.last(),
        Some(&(search.total, search.total, search.found.len() as u32))
    );
    // 一時フォルダは残らない。
    assert_eq!(std::fs::read_dir(scratch.path()).expect("読めること").count(), 0);
}

#[test]
fn a_cancelled_search_stops_and_says_so() {
    let snapshot = load();
    let scratch = tempfile::tempdir().expect("一時ディレクトリ");
    let cancel = Cancel::new();
    let mut seen = 0;
    let search = contained::find_containers_in(
        &log(),
        "git",
        &repo(),
        &snapshot,
        "refs/heads/squashed",
        &cancel,
        // 1 本調べたところで止める。
        &mut |done, _, _| {
            seen = done;
            if done == 1 {
                cancel.cancel();
            }
        },
        scratch.path(),
    )
    .expect("中止しても失敗にはしない");
    assert!(search.cancelled);
    assert_eq!(search.checked, 1, "止めたのに調べ続けた");
    assert!(search.total > 1);
    assert_eq!(seen, 1);
}

#[test]
fn searching_from_a_tag_is_refused() {
    let snapshot = load();
    assert!(contained::container_candidates(&snapshot, "refs/tags/squash-tag").is_err());
    assert!(contained::container_candidates(&snapshot, "refs/heads/nothing").is_err());
}

#[test]
fn a_branch_merged_into_this_one_does_not_count_as_taking_it_in() {
    // squashed は merged-normally を取り込んだ main から分かれた。squashed の一番古いコミットは
    // その**マージコミット**で、中身は merged-normally にある。それだけで「4 個中 1 個まで入っている」と
    // 答えてはいけない（ブランチ自身の変更は 1 つも入っていない）。
    assert_eq!(check("squashed", "merged-normally"), Containment::NotContained);
}
