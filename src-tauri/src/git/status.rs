//! 作業ツリーの状態（docs/DESIGN.md §7.5）。
//!
//! **read-only。** stage / unstage / discard / stash は一切提供しない（CLAUDE.md §1）。
//! ここが返すのは「今どうなっているか」だけで、変える手段は持たない。
//!
//! 取得は git を 3 回:
//!
//! | 何を | コマンド |
//! |---|---|
//! | ステージ済み | `diff --cached --raw --numstat -z -M` |
//! | 未ステージ | `diff --raw --numstat -z -M` |
//! | 未追跡と衝突 | `status --porcelain=v2 -z` |
//!
//! 前 2 つは [`crate::git::diff::parse_changes`] をそのまま通せば、状態・モード・
//! 増減行数まで揃う。`--porcelain=v2` には増減行数が無いので、そちらは未追跡と
//! 衝突の検出にだけ使う。

use std::path::Path;

use serde::Serialize;

use crate::commandlog::LogSink;

use super::diff::{changed_files, FileChange, Revisions};
use super::exec;

/// 作業ツリーの状態。**どれも空ならクリーン**（擬似行を出さない）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTree {
    /// HEAD と index の差。
    pub staged: Vec<FileChange>,
    /// index と作業ツリーの差。
    pub unstaged: Vec<FileChange>,
    /// 未追跡ファイルのパス。**差分としては見せない**（docs/DESIGN.md §7.5）。
    pub untracked: Vec<String>,
    /// 衝突しているパス。ステージ済みでも未ステージでもないので別に持つ。
    pub unmerged: Vec<String>,
    /// `index.lock` が残っている。**消さない。表示するだけ**（CLAUDE.md §2）。
    ///
    /// 場所は `rev-parse --absolute-git-dir` に聞く。**`<path>/.git` を組み立てない** —
    /// リンクされた作業ツリーでは `.git` がファイル、bare では無いので、
    /// どちらでも「残っていない」と静かに嘘をつく。
    pub index_lock_present: bool,
}

impl WorkingTree {
    /// 何も変わっていないか。**擬似行を出すかどうかの判断はこれ 1 つ**。
    pub fn is_clean(&self) -> bool {
        self.staged.is_empty()
            && self.unstaged.is_empty()
            && self.untracked.is_empty()
            && self.unmerged.is_empty()
    }
}

/// 作業ツリーの状態を取る。
pub fn working_tree(log: &dyn LogSink, program: &str, repo: &Path) -> Result<WorkingTree, String> {
    let status = run_status(log, program, repo)?;

    // 一覧の作り方はコミットのときと同じ（`--raw` と `--numstat` を 1 回で）。
    let mut staged = changed_files(log, program, repo, Revisions::WorkingTree { staged: true })?;
    let mut unstaged = changed_files(log, program, repo, Revisions::WorkingTree { staged: false })?;

    // **衝突しているパスは `diff --raw` にも出る**（状態 `U`、しかも同じパスが
    // 未ステージ側に 2 度出る）。衝突は別に数えているので、ここから外す。
    staged.retain(|change| !status.unmerged.contains(&change.path));
    unstaged.retain(|change| !status.unmerged.contains(&change.path));

    Ok(WorkingTree {
        staged,
        unstaged,
        untracked: status.untracked,
        unmerged: status.unmerged,
        index_lock_present: super::repo::git_dir(log, program, repo)
            .is_some_and(|dir| dir.join("index.lock").is_file()),
    })
}

fn run_status(log: &dyn LogSink, program: &str, repo: &Path) -> Result<StatusRecords, String> {
    let output = exec::run(
        log,
        program,
        Some(repo),
        &["status", "--porcelain=v2", "-z"],
    )?;
    if !output.ok() {
        return Err(output.failure("作業ツリーの状態を読めませんでした"));
    }

    Ok(parse_status(&String::from_utf8_lossy(&output.stdout)))
}

/// 未追跡ファイルをこれ以上は読まない。差分の折りたたみ（`ui.collapseBytes`）と
/// 同じ考えで、**開いた瞬間に固まらない**ことを優先する。
pub const MAX_WORKING_FILE_BYTES: u64 = 512 * 1024;

/// 未追跡ファイルの中身。**全文表示のためのもの**（差分にはしない — DESIGN.md §7.5）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingFile {
    pub path: String,
    pub size: u64,
    /// バイナリでも大きすぎるときでも `None`。
    pub text: Option<crate::encoding::DecodedText>,
    pub binary: bool,
    pub too_large: bool,
}

/// 未追跡ファイルを読む。
///
/// **git を通さない。** 追跡されていないファイルは git のオブジェクトになっていないので、
/// ファイルを直接読むしかない。**文字コードの判別は `encoding::decode` を通す**
/// （CLAUDE.md §10）。
///
/// `relative` はリポジトリからの相対パス。**`..` を含むものは拒む** —
/// 呼び出し元は自分が出した一覧を渡すはずだが、外へ出られる経路は作らない。
pub fn read_working_file(repo: &Path, relative: &str) -> Result<WorkingFile, String> {
    if relative.split(['/', '\\']).any(|part| part == "..") {
        return Err(format!("リポジトリの外は読めません: {relative}"));
    }

    let full = repo.join(relative);
    let size = std::fs::metadata(&full)
        .map_err(|error| format!("ファイルを読めません: {relative}（{error}）"))?
        .len();

    if size > MAX_WORKING_FILE_BYTES {
        return Ok(WorkingFile {
            path: relative.to_string(),
            size,
            text: None,
            binary: false,
            too_large: true,
        });
    }

    let bytes = std::fs::read(&full)
        .map_err(|error| format!("ファイルを読めません: {relative}（{error}）"))?;

    Ok(match crate::encoding::decode(&bytes, None) {
        crate::encoding::Decoded::Binary { .. } => WorkingFile {
            path: relative.to_string(),
            size,
            text: None,
            binary: true,
            too_large: false,
        },
        crate::encoding::Decoded::Text(text) => WorkingFile {
            path: relative.to_string(),
            size,
            text: Some(text),
            binary: false,
            too_large: false,
        },
    })
}

/// `--porcelain=v2 -z` から拾うもの。
#[derive(Debug, Default, PartialEq)]
pub struct StatusRecords {
    pub untracked: Vec<String>,
    pub unmerged: Vec<String>,
}

/// `status --porcelain=v2 -z` を読む。
///
/// **記録の種類を全部扱う。** 使うのは `?`（未追跡）と `u`（衝突）だけだが、
/// **リネーム（`2`）はパスを 2 つ食う**ので、読み飛ばし方を間違えると以降が全部ずれる。
///
/// 記録の形（`-z` では行の区切りも NUL、`2` の記録内のタブも NUL になる）:
///
/// ```text
/// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
/// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> <origPath>
/// u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
/// ? <path>
/// ! <path>
/// ```
pub fn parse_status(text: &str) -> StatusRecords {
    let mut records = StatusRecords::default();
    // 空文字列を `split('\0')` すると空の 1 要素が返るので、そこで弾く。
    if text.is_empty() {
        return records;
    }

    let mut fields = text.split('\0').filter(|field| !field.is_empty());
    while let Some(record) = fields.next() {
        match record.as_bytes().first() {
            // 未追跡と無視。`? <path>` は 1 記録で 1 フィールド。
            Some(b'?') => records.untracked.push(record[2..].to_string()),
            Some(b'!') => {}
            Some(b'u') => records.unmerged.push(unmerged_path(record)),
            // **リネームとコピーだけ、続く NUL フィールドを 1 つ余分に食う**
            // （元のパス）。ここを飛ばさないと、次の記録が元のパスにずれる。
            Some(b'2') => {
                fields.next();
            }
            _ => {}
        }
    }

    records
}

/// `u` 記録のパスを取る。**空白を含むパスがあるので、後ろから数えない。**
///
/// `u` の固定フィールドは 10 個（`u` 自身を含む）で、11 個目以降がパス。
/// パスに空白があっても壊れないよう、区切りを 10 回だけ飛ばして残り全部を取る。
fn unmerged_path(record: &str) -> String {
    record
        .splitn(11, ' ')
        .nth(10)
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{parse_status, StatusRecords};

    /// `-z` の記録区切り。読みやすさのため、テストでは `|` で書いて置き換える。
    fn z(text: &str) -> String {
        text.replace('|', "\0")
    }

    #[test]
    fn an_empty_status_has_nothing() {
        assert_eq!(parse_status(""), StatusRecords::default());
    }

    #[test]
    fn reads_untracked_paths() {
        let records = parse_status(&z("? 未追跡.txt|? sub/other.txt|"));
        assert_eq!(records.untracked, vec!["未追跡.txt", "sub/other.txt"]);
        assert!(records.unmerged.is_empty());
    }

    /// **リネームはパスを 2 つ食う。** 飛ばさないと元のパスが次の記録に見える。
    #[test]
    fn a_rename_consumes_two_paths() {
        let records = parse_status(&z(concat!(
            "2 R. N... 100644 100644 100644 aaa bbb R100 新しい名前.txt|古い名前.txt|",
            "? 未追跡.txt|"
        )));
        assert_eq!(
            records.untracked,
            vec!["未追跡.txt"],
            "元のパスを未追跡と取り違えていないこと"
        );
    }

    #[test]
    fn ordinary_records_are_skipped() {
        let records = parse_status(&z(concat!(
            "1 M. N... 100644 100644 100644 aaa bbb staged.txt|",
            "1 .M N... 100644 100644 100644 aaa bbb unstaged.txt|",
            "? 未追跡.txt|"
        )));
        assert_eq!(records.untracked, vec!["未追跡.txt"]);
    }

    #[test]
    fn reads_unmerged_paths() {
        let records = parse_status(&z(
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc f.txt|",
        ));
        assert_eq!(records.unmerged, vec!["f.txt"]);
    }

    /// パスに空白があっても、後ろから数えていないので壊れない。
    #[test]
    fn a_path_with_spaces_survives() {
        let records = parse_status(&z(concat!(
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc 名前に 空白.txt|",
            "? もう 1 つ.txt|"
        )));
        assert_eq!(records.unmerged, vec!["名前に 空白.txt"]);
        assert_eq!(records.untracked, vec!["もう 1 つ.txt"]);
    }

    /// 無視されているファイル（`!`）は数に入れない。
    #[test]
    fn ignored_files_are_not_untracked() {
        let records = parse_status(&z("! target/|? 未追跡.txt|"));
        assert_eq!(records.untracked, vec!["未追跡.txt"]);
    }
}
