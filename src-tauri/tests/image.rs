//! 画像差分の片側を読む（T-46）の結合テスト。
//!
//! 生成済みリポジトリ `images`（`scripts/make-test-repos.sh`）に対して実際の git を走らせる。
//! 見るのは、**差分の種類と側ごとに正しい場所を読むこと**（コミット・マージベース・HEAD・index・ディスク）と、
//! **無い側を読むときに失敗をログに残さないこと**、作業ツリーの守り（`..` / 上限）。

mod common;

use std::path::PathBuf;
use std::process::Command;

use gitpeek_lib::git::diff::Revisions;
use gitpeek_lib::git::image::{self, ImageHead, Location, LoadedImage, Side, MAX_IMAGE_BYTES};

use common::{fixtures, log};

fn repo() -> PathBuf {
    fixtures().join("images")
}

/// 要約からコミットを引く。テストの中なので git を直接呼んでよい。
fn sha_of(subject: &str) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo())
        .args(["log", "--all", "--format=%H %s"])
        .output()
        .expect("git を起動できること");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.split_once(' ').filter(|(_, s)| *s == subject).map(|(sha, _)| sha.to_string()))
        .unwrap_or_else(|| panic!("要約 {subject:?} のコミットが無い"))
}

fn parent_of(sha: &str) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo())
        .args(["rev-parse", &format!("{sha}^")])
        .output()
        .expect("git を起動できること");
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn read(revisions: &Revisions<'_>, path: &str, old_path: Option<&str>, side: Side) -> LoadedImage {
    let sink = log();
    let location = image::locate(&sink, "git", &repo(), revisions, path, old_path, side)
        .unwrap_or_else(|error| panic!("{path} の場所を決められません: {error}"));
    let loaded = image::load(&sink, "git", &repo(), &location)
        .unwrap_or_else(|error| panic!("{path} を読めません: {error}"));
    // **無い側を読んでも、失敗をログに残さない**（`cat-file <rev>:<path>` を使わない理由）。
    for entry in sink.entries() {
        assert!(entry.ok, "失敗が記録された: {:?}", entry.args);
    }
    loaded
}

fn mime(loaded: &LoadedImage) -> &'static str {
    match loaded.head {
        ImageHead::Image { mime, .. } => mime,
        ref other => panic!("画像のはずが {other:?}"),
    }
}

#[test]
fn a_redrawn_image_has_both_sides() {
    let sha = sha_of("画像: 描き直す");
    let parent = parent_of(&sha);
    let range = Revisions::Range { from: Some(&parent), to: &sha, symmetric: false };

    let old = read(&range, "icon.png", None, Side::Old);
    let new = read(&range, "icon.png", None, Side::New);
    assert_eq!(mime(&old), "image/png");
    assert_eq!(mime(&new), "image/png");
    assert_ne!(old.bytes, new.bytes, "描き直したので中身が違う");
    assert_eq!(old.head, ImageHead::Image { mime: "image/png", size: old.bytes.len() as u64 });
}

#[test]
fn the_root_commit_has_no_old_side_and_a_fake_image_is_not_an_image() {
    let sha = sha_of("画像: 追加");
    let root = Revisions::Range { from: None, to: &sha, symmetric: false };

    assert_eq!(read(&root, "icon.png", None, Side::Old).head, ImageHead::Absent);
    assert_eq!(mime(&read(&root, "icon.png", None, Side::New)), "image/png");
    // **拡張子ではなく中身で見る。**
    assert!(matches!(read(&root, "fake.png", None, Side::New).head, ImageHead::NotImage { .. }));
}

#[test]
fn a_renamed_image_reads_the_old_side_under_the_old_name() {
    let sha = sha_of("画像: 名前を変える");
    let parent = parent_of(&sha);
    let range = Revisions::Range { from: Some(&parent), to: &sha, symmetric: false };

    let old = read(&range, "img/icon.png", Some("icon.png"), Side::Old);
    let new = read(&range, "img/icon.png", Some("icon.png"), Side::New);
    assert_eq!(old.bytes, new.bytes, "名前だけ変えた");
    assert_eq!(mime(&old), "image/png");
}

#[test]
fn a_deleted_file_has_no_new_side() {
    let sha = sha_of("画像: GIF を足して偽物を消す");
    let parent = parent_of(&sha);
    let range = Revisions::Range { from: Some(&parent), to: &sha, symmetric: false };

    assert_eq!(read(&range, "fake.png", None, Side::New).head, ImageHead::Absent);
    assert_eq!(read(&range, "anim.gif", None, Side::Old).head, ImageHead::Absent);
    assert_eq!(mime(&read(&range, "anim.gif", None, Side::New)), "image/gif");
}

/// `A...B` の変更前は**マージベース**（差分の側と揃える）。`A B` なら A そのもの。
#[test]
fn a_symmetric_compare_reads_the_old_side_at_the_merge_base() {
    let symmetric = Revisions::Range { from: Some("main"), to: "other", symmetric: true };
    let plain = Revisions::Range { from: Some("main"), to: "other", symmetric: false };

    let base = read(&symmetric, "icon.png", None, Side::Old);
    assert_eq!(mime(&base), "image/png", "分かれた時点では PNG");
    assert_eq!(mime(&read(&symmetric, "icon.png", None, Side::New)), "image/gif");
    // main では名前を変えたので、icon.png は無い。
    assert_eq!(read(&plain, "icon.png", None, Side::Old).head, ImageHead::Absent);
}

#[test]
fn the_working_tree_reads_head_index_and_disk() {
    let staged = Revisions::WorkingTree { staged: true };
    let unstaged = Revisions::WorkingTree { staged: false };

    // HEAD → index（index は png_a に戻してある）
    let head = read(&staged, "img/icon.png", None, Side::Old);
    let index = read(&staged, "img/icon.png", None, Side::New);
    assert_eq!(mime(&head), "image/png");
    assert_eq!(mime(&index), "image/png");
    assert_ne!(head.bytes, index.bytes);

    // index → ディスク（ディスクは GIF）
    assert_eq!(read(&unstaged, "img/icon.png", None, Side::Old).bytes, index.bytes);
    assert_eq!(mime(&read(&unstaged, "img/icon.png", None, Side::New)), "image/gif");
}

/// 未追跡は index に無いので変更前は無く、変更後はディスクから読む。
#[test]
fn an_untracked_image_is_read_from_disk() {
    let unstaged = Revisions::WorkingTree { staged: false };
    assert_eq!(read(&unstaged, "new.png", None, Side::Old).head, ImageHead::Absent);
    assert_eq!(mime(&read(&unstaged, "new.png", None, Side::New)), "image/png");
}

/* ---------- 作業ツリーの守り（git は呼ばない）---------- */

fn disk(dir: &std::path::Path, path: &str) -> Result<LoadedImage, String> {
    image::load(&log(), "git", dir, &Location::Disk { path: path.to_string() })
}

#[test]
fn the_disk_side_refuses_to_leave_the_repository() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    assert!(disk(dir.path(), "../secret.png").is_err());
    assert!(disk(dir.path(), "a\\..\\..\\secret.png").is_err());
}

#[test]
fn the_disk_side_does_not_read_past_the_limit() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let big = dir.path().join("big.png");
    let file = std::fs::File::create(&big).expect("作れること");
    file.set_len(MAX_IMAGE_BYTES + 1).expect("大きさを決められること");
    assert_eq!(
        disk(dir.path(), "big.png").unwrap().head,
        ImageHead::TooLarge { size: MAX_IMAGE_BYTES + 1 }
    );
    // ちょうど上限は読む（画像ではないので NotImage）。
    std::fs::File::create(dir.path().join("edge.bin"))
        .unwrap()
        .set_len(MAX_IMAGE_BYTES)
        .unwrap();
    assert!(matches!(disk(dir.path(), "edge.bin").unwrap().head, ImageHead::NotImage { .. }));
}

#[test]
fn a_file_gone_from_disk_is_absent() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    assert_eq!(disk(dir.path(), "gone.png").unwrap().head, ImageHead::Absent);
}
