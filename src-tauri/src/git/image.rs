//! 画像差分の片側を読む（T-46。docs/DESIGN.md §7.2.1）。
//!
//! **読むだけ。** git に頼むのは `ls-tree` / `ls-files -s` / `cat-file`（と、マージベース起点の比較での
//! `merge-base`）で、どれもリポジトリに書かない（CLAUDE.md §1）。作業ツリーの側はファイルを直接読む。
//!
//! **画像かどうかは中身の先頭バイトで決める**（拡張子は見ない）。拡張子が違う・壊れているものは
//! 「画像ではない」と返し、画面はいまどおりサイズだけの表示に戻る。
//!
//! 画面へは **JSON の見出し 1 行 ＋ 改行 ＋ 生のバイト列**で渡す（[`encode`]）。base64 にしないので
//! 10 MB の画像でも 13 MB の文字列を作らずに済み、依存も増えない。

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::commandlog::LogSink;
use crate::git::diff::Revisions;
use crate::git::exec;

/// 1 枚の上限。**超えたものは読まない**（サイズだけ返す。2026-11-11 に利用者が了承）。
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// どちらの側を読むか。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Old,
    New,
}

/// 見出し。**画面の `ImageHead`（`src/lib/imageDiff.ts`）と同じ形。**
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ImageHead {
    /// その側にファイルが無い（追加の変更前・削除の変更後）。
    Absent,
    /// 上限を超えたので読んでいない。
    TooLarge { size: u64 },
    /// 読んだが画像ではなかった（知らない形式・壊れている・symlink）。
    NotImage { size: u64 },
    Image { mime: &'static str, size: u64 },
}

/// 読んだ結果。`bytes` は `Image` のときだけ中身がある。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedImage {
    pub head: ImageHead,
    pub bytes: Vec<u8>,
}

impl LoadedImage {
    fn head_only(head: ImageHead) -> Self {
        Self {
            head,
            bytes: Vec::new(),
        }
    }

    /// 読んだバイト列を見分けて包む。
    fn from_bytes(bytes: Vec<u8>) -> Self {
        let size = bytes.len() as u64;
        match sniff(&bytes) {
            Some(mime) => Self {
                head: ImageHead::Image { mime, size },
                bytes,
            },
            None => Self::head_only(ImageHead::NotImage { size }),
        }
    }
}

/// 画面へ渡す形にする — **JSON の見出し 1 行、改行、生のバイト列。**
///
/// serde_json は文字列の中の改行を `\n` に逃がすので、見出しに生の改行は入らない
/// （最初の改行が必ず区切りになる）。
pub fn encode(loaded: &LoadedImage) -> Vec<u8> {
    let mut out = serde_json::to_vec(&loaded.head).unwrap_or_else(|_| b"{\"kind\":\"absent\"}".to_vec());
    out.push(b'\n');
    out.extend_from_slice(&loaded.bytes);
    out
}

/// 先頭のバイトから画像の種類を見分ける。**知らないものは `None`**（SVG はテキストなので対象外）。
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 14 && bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.len() >= 6 && bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) && bytes[4..6] != [0, 0] {
        // ICO。4〜5 バイト目は枚数で、0 枚の ICO は無い（0 で始まるだけのファイルを拾わない）。
        Some("image/x-icon")
    } else {
        None
    }
}

/// その側のファイルがどこにあるか。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Location {
    Absent,
    /// コミット（や `HEAD`）の中のファイル。
    Revision { rev: String, path: String },
    /// index（`:<path>`）。
    Index { path: String },
    /// 作業ツリーのファイル。git を通さずに読む。
    Disk { path: String },
}

/// 差分の種類と側から、読む場所を決める。**git を呼ぶのはマージベース起点の変更前だけ。**
pub fn locate(
    log: &dyn LogSink,
    program: &str,
    repo: &Path,
    revisions: &Revisions<'_>,
    path: &str,
    old_path: Option<&str>,
    side: Side,
) -> Result<Location, String> {
    let old = old_path.unwrap_or(path).to_string();
    let new = path.to_string();
    Ok(match (revisions, side) {
        (Revisions::Range { from: None, .. }, Side::Old) => Location::Absent,
        (Revisions::Range { from: Some(from), to, symmetric }, Side::Old) => {
            // `A...B` の変更前はマージベース（差分の側と揃える。docs/DESIGN.md §10.3）。
            let rev = if *symmetric {
                match merge_base(log, program, repo, from, to)? {
                    Some(base) => base,
                    None => return Ok(Location::Absent),
                }
            } else {
                from.to_string()
            };
            Location::Revision { rev, path: old }
        }
        (Revisions::Range { to, .. }, Side::New) => Location::Revision {
            rev: to.to_string(),
            path: new,
        },
        (Revisions::WorkingTree { staged: true }, Side::Old) => Location::Revision {
            rev: "HEAD".to_string(),
            path: old,
        },
        (Revisions::WorkingTree { staged: true }, Side::New) => Location::Index { path: new },
        (Revisions::WorkingTree { staged: false }, Side::Old) => Location::Index { path: old },
        (Revisions::WorkingTree { staged: false }, Side::New) => Location::Disk { path: new },
    })
}

/// 読む。**上限を超えるものは中身を読まない**（大きさを先に聞く）。
pub fn load(
    log: &dyn LogSink,
    program: &str,
    repo: &Path,
    location: &Location,
) -> Result<LoadedImage, String> {
    match location {
        Location::Absent => Ok(LoadedImage::head_only(ImageHead::Absent)),
        Location::Revision { rev, path } => match tree_blob(log, program, repo, rev, path)? {
            None => Ok(LoadedImage::head_only(ImageHead::Absent)),
            Some((sha, size)) => read_blob(log, program, repo, &sha, size),
        },
        Location::Index { path } => match index_blob(log, program, repo, path)? {
            None => Ok(LoadedImage::head_only(ImageHead::Absent)),
            Some(sha) => {
                let size = blob_size(log, program, repo, &sha)?;
                read_blob(log, program, repo, &sha, size)
            }
        },
        Location::Disk { path } => read_disk(repo, path),
    }
}

fn read_blob(
    log: &dyn LogSink,
    program: &str,
    repo: &Path,
    sha: &str,
    size: u64,
) -> Result<LoadedImage, String> {
    if size > MAX_IMAGE_BYTES {
        return Ok(LoadedImage::head_only(ImageHead::TooLarge { size }));
    }
    let output = exec::run(log, program, Some(repo), &["cat-file", "blob", sha])?;
    if !output.ok() {
        return Err(output.failure("画像を読めませんでした"));
    }
    Ok(LoadedImage::from_bytes(output.stdout))
}

/// コミットの中のファイルの blob とバイト数。無ければ `None`。
///
/// **`cat-file` に `<rev>:<path>` を渡さない** — 無いパスだと失敗としてログに残る（§7.2 のサイズと同じ理由）。
/// `ls-tree` は無ければ空を返して成功する。**rev 自体が無い**（コミットの無い HEAD）ときは失敗するので、それも無い扱い。
fn tree_blob(
    log: &dyn LogSink,
    program: &str,
    repo: &Path,
    rev: &str,
    path: &str,
) -> Result<Option<(String, u64)>, String> {
    let output = exec::run(
        log,
        program,
        Some(repo),
        &["--literal-pathspecs", "ls-tree", "-l", "-z", rev, "--", path],
    )?;
    if !output.ok() {
        return Ok(None);
    }
    Ok(parse_ls_tree(&output.stdout))
}

/// `<mode> <type> <object> <size>\t<path>`。**blob でなければ無い扱い**（サブモジュールは commit）。
fn parse_ls_tree(stdout: &[u8]) -> Option<(String, u64)> {
    let record = String::from_utf8_lossy(stdout);
    let head = record.split('\0').next()?.split('\t').next()?;
    let mut fields = head.split_whitespace();
    let _mode = fields.next()?;
    if fields.next()? != "blob" {
        return None;
    }
    let sha = fields.next()?.to_string();
    let size = fields.next()?.parse().ok()?;
    Some((sha, size))
}

/// index にあるファイルの blob。無ければ `None`。**衝突中は最初の段を取る。**
fn index_blob(
    log: &dyn LogSink,
    program: &str,
    repo: &Path,
    path: &str,
) -> Result<Option<String>, String> {
    let output = exec::run(
        log,
        program,
        Some(repo),
        &["--literal-pathspecs", "ls-files", "-s", "-z", "--", path],
    )?;
    if !output.ok() {
        return Err(output.failure("index を読めませんでした"));
    }
    Ok(parse_ls_files(&output.stdout))
}

/// `<mode> <object> <stage>\t<path>`。
fn parse_ls_files(stdout: &[u8]) -> Option<String> {
    let record = String::from_utf8_lossy(stdout);
    let head = record.split('\0').next()?.split('\t').next()?;
    let sha = head.split_whitespace().nth(1)?;
    (!sha.is_empty()).then(|| sha.to_string())
}

fn blob_size(log: &dyn LogSink, program: &str, repo: &Path, sha: &str) -> Result<u64, String> {
    let output = exec::run(log, program, Some(repo), &["cat-file", "-s", sha])?;
    if !output.ok() {
        return Err(output.failure("画像の大きさを読めませんでした"));
    }
    output
        .stdout_lossy()
        .trim()
        .parse()
        .map_err(|_| "画像の大きさを読めませんでした".to_string())
}

/// 作業ツリーのファイルを直接読む。
///
/// **`..` を含むものは拒む**（`status::read_working_file` と同じ）。**symlink は辿らない** —
/// 辿るとリポジトリの外の画像（やファイル）を読めてしまう。消えていれば無い扱い。
fn read_disk(repo: &Path, relative: &str) -> Result<LoadedImage, String> {
    if relative.split(['/', '\\']).any(|part| part == "..") {
        return Err(format!("リポジトリの外は読めません: {relative}"));
    }
    let full = repo.join(relative);
    let Ok(meta) = std::fs::symlink_metadata(&full) else {
        return Ok(LoadedImage::head_only(ImageHead::Absent));
    };
    if meta.file_type().is_symlink() {
        return Ok(LoadedImage::head_only(ImageHead::NotImage { size: meta.len() }));
    }
    if !meta.is_file() {
        return Ok(LoadedImage::head_only(ImageHead::Absent));
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Ok(LoadedImage::head_only(ImageHead::TooLarge { size: meta.len() }));
    }
    let bytes = std::fs::read(&full)
        .map_err(|error| format!("ファイルを読めません: {relative}（{error}）"))?;
    Ok(LoadedImage::from_bytes(bytes))
}

fn merge_base(
    log: &dyn LogSink,
    program: &str,
    repo: &Path,
    a: &str,
    b: &str,
) -> Result<Option<String>, String> {
    let output = exec::run(log, program, Some(repo), &["merge-base", a, b])?;
    // 共通の祖先が無いと exit 1 で何も出さない。
    if output.exit_code == Some(1) && output.stdout.is_empty() {
        return Ok(None);
    }
    if !output.ok() {
        return Err(output.failure("マージベースを求められませんでした"));
    }
    let sha = output.stdout_lossy().trim().to_string();
    Ok((!sha.is_empty()).then_some(sha))
}

#[cfg(test)]
mod tests {
    use super::{encode, parse_ls_files, parse_ls_tree, sniff, ImageHead, LoadedImage};

    #[test]
    fn tells_image_formats_by_their_first_bytes() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"), Some("image/png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10]), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a\x01\0\x01\0"), Some("image/gif"));
        assert_eq!(sniff(b"GIF87a\x01\0\x01\0"), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\x24\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"BM\x36\0\0\0\0\0\0\0\x36\0\0\0"), Some("image/bmp"));
        assert_eq!(sniff(&[0, 0, 1, 0, 1, 0, 16, 16]), Some("image/x-icon"));
    }

    /// **拡張子ではなく中身で見る**ので、画像の名前をしたテキストや、形の崩れたものは拾わない。
    #[test]
    fn leaves_out_what_is_not_an_image() {
        assert_eq!(sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), None, "SVG はテキストとして差分が出る");
        assert_eq!(sniff(b"hello"), None);
        assert_eq!(sniff(b""), None);
        assert_eq!(sniff(b"RIFF\x24\0\0\0WAVEfmt "), None, "RIFF でも WAV は画像ではない");
        assert_eq!(sniff(&[0, 0, 1, 0, 0, 0]), None, "0 枚の ICO は無い");
        assert_eq!(sniff(b"BM"), None, "BMP の見出しに足りない");
        assert_eq!(sniff(&[0x89, b'P', b'N']), None, "途中で切れた PNG");
    }

    #[test]
    fn reads_an_ls_tree_record() {
        let record = b"100644 blob 0123456789abcdef0123456789abcdef01234567    1234\tdocs/a b.png\0";
        assert_eq!(
            parse_ls_tree(record),
            Some(("0123456789abcdef0123456789abcdef01234567".to_string(), 1234))
        );
        assert_eq!(parse_ls_tree(b""), None, "無ければ空");
        let submodule = b"160000 commit 0123456789abcdef0123456789abcdef01234567       -\tsub\0";
        assert_eq!(parse_ls_tree(submodule), None, "サブモジュールは画像ではない");
    }

    #[test]
    fn reads_an_ls_files_record() {
        let record = b"100644 0123456789abcdef0123456789abcdef01234567 0\ticon.png\0";
        assert_eq!(
            parse_ls_files(record).as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        assert_eq!(parse_ls_files(b""), None);
    }

    /// 見出しは 1 行で、**最初の改行のあとは中身そのまま**（中身に改行が入っていても崩れない）。
    #[test]
    fn encodes_a_one_line_head_then_the_bytes() {
        let loaded = LoadedImage {
            head: ImageHead::Image {
                mime: "image/png",
                size: 4,
            },
            bytes: vec![b'\n', 0, 0xFF, b'\n'],
        };
        let out = encode(&loaded);
        let split = out.iter().position(|&b| b == b'\n').unwrap();
        let head: serde_json::Value = serde_json::from_slice(&out[..split]).unwrap();
        assert_eq!(head, serde_json::json!({ "kind": "image", "mime": "image/png", "size": 4 }));
        assert_eq!(&out[split + 1..], &[b'\n', 0, 0xFF, b'\n']);

        let absent = encode(&LoadedImage {
            head: ImageHead::TooLarge { size: 99 },
            bytes: Vec::new(),
        });
        assert_eq!(absent, b"{\"kind\":\"tooLarge\",\"size\":99}\n".to_vec());
    }
}
