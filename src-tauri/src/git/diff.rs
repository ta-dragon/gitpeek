//! コミット本文と変更ファイル一覧の取得（docs/DESIGN.md §7.3, §7.4 / 付録 A）。
//!
//! **差分の本体はここでは扱わない**（T-13）。ここが返すのは「どのファイルが
//! どう変わり、何行増減したか」までで、hunk には踏み込まない。
//!
//! マージコミットの差分は一意に決まらないので、**親は呼び出し側が指定する**
//! （既定は第 1 親 — docs/DESIGN.md §7.4）。`--cc` は v1 では使わない。

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use crate::commandlog::LogSink;
use crate::git::exec;

/// フィールド区切り（Unit Separator）。コミットメッセージにまず現れない。
const FIELD: char = '\u{1f}';

/// `git show -s` の書式。**`git log` と同じ書式言語**なので `%x1f` が 0x1F に展開される
/// （`for-each-ref` だけが別 — [`super::refs`]）。
///
/// 本文（`%b`）を最後に置くのは、区切り文字を含んでいても末尾フィールドとして
/// 丸ごと残せるようにするため。
const DETAIL_FORMAT: &str =
    "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%s%x1f%b";

/// コミット 1 件の本文。一覧に載っている [`crate::model::CommitMeta`] との違いは
/// **コミッターと本文を持つ**こと。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,
    pub short_sha: String,
    /// 第 1 親が先頭。ルートコミットは空。
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub committer_time: i64,
    pub subject: String,
    /// subject を除いた本文。無ければ空文字。
    pub body: String,
}

/// 変更の種類。`-C`（コピー検出）を付けないので `Copied` は本来出ないが、
/// 利用者の `.gitconfig` に `diff.renames=copies` があると出るため受けておく。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    /// 型変更（通常ファイル ↔ シンボリックリンクなど）。
    TypeChanged,
    Unknown,
}

impl ChangeStatus {
    /// raw 出力の状態欄。`R075` のように類似度が続くので先頭 1 文字だけを見る。
    fn parse(field: &str) -> Self {
        match field.as_bytes().first() {
            Some(b'A') => Self::Added,
            Some(b'M') => Self::Modified,
            Some(b'D') => Self::Deleted,
            Some(b'R') => Self::Renamed,
            Some(b'C') => Self::Copied,
            Some(b'T') => Self::TypeChanged,
            _ => Self::Unknown,
        }
    }

    /// リネームとコピーだけ、続く NUL フィールドを 2 つ食う。
    fn takes_two_paths(self) -> bool {
        matches!(self, Self::Renamed | Self::Copied)
    }
}

/// 変更ファイル 1 件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// 変更後のパス。差分の取得と表示にはこちらを使う。削除では削除されたパス。
    pub path: String,
    /// リネーム / コピー元。それ以外は `None`。
    pub old_path: Option<String>,
    pub status: ChangeStatus,
    /// 追加行数。**バイナリでは `None`**（numstat に `-` が出る）。
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    /// 変更前のファイルモード（`100644`）。追加では `000000`。
    pub old_mode: String,
    pub new_mode: String,
}

impl FileChange {
    /// 増減行数が取れないファイル。numstat が `-` を返すのはバイナリのときだけ。
    pub fn is_binary(&self) -> bool {
        self.additions.is_none() && self.deletions.is_none()
    }
}

/// コミット本文を取る。
pub fn commit_detail(
    log: &dyn LogSink,
    program: &str,
    path: &Path,
    sha: &str,
) -> Result<CommitDetail, String> {
    let output = exec::run(log, program, Some(path), &["show", "-s", DETAIL_FORMAT, sha])?;
    if !output.ok() {
        return Err(output.failure("コミットの本文を取得できませんでした"));
    }

    // メッセージの文字コードは git が UTF-8 へ寄せる（commit の encoding ヘッダ）。
    parse_detail(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| format!("コミットの本文を読み取れませんでした: {sha}"))
}

/// 変更ファイル一覧を取る。
///
/// `parent` が `None` のときは**ルートコミット**として扱い、空ツリーとの差分を出す。
/// マージコミットでは呼び出し側がどの親と比べるかを決める（docs/DESIGN.md §7.4）。
///
/// **`--raw` と `--numstat` を 1 回の実行で両方出す。** raw から状態とファイルモード、
/// numstat から増減行数とバイナリ判定が取れるので、2 回呼ぶ必要はない。
pub fn changed_files(
    log: &dyn LogSink,
    program: &str,
    path: &Path,
    parent: Option<&str>,
    sha: &str,
) -> Result<Vec<FileChange>, String> {
    let output = match parent {
        Some(parent) => exec::run(
            log,
            program,
            Some(path),
            &["diff", "--raw", "--numstat", "-z", "-M", parent, sha],
        )?,
        // `git diff` はルートコミットを片側に取れない。`diff-tree --root` なら
        // 空ツリーとの差分として出せる（`-r` が無いとサブディレクトリを潜らない）。
        None => exec::run(
            log,
            program,
            Some(path),
            &[
                "diff-tree",
                "--raw",
                "--numstat",
                "-z",
                "-M",
                "--root",
                "--no-commit-id",
                "-r",
                sha,
            ],
        )?,
    };
    if !output.ok() {
        return Err(output.failure("変更ファイルの一覧を取得できませんでした"));
    }

    // パス名は `core.quotepath=false` により生バイトで出る。UTF-8 として読めない名前は
    // 置換文字になる（v1 の割り切り。文字コード判別はファイル内容だけ — DESIGN.md §9.1）。
    Ok(parse_changes(&String::from_utf8_lossy(&output.stdout)))
}

fn parse_detail(stdout: &str) -> Option<CommitDetail> {
    // 末尾の改行だけ落とす。本文中の改行には触らない。
    let record = stdout.trim_end_matches('\n');
    if record.is_empty() {
        return None;
    }

    // 11 分割。本文に区切り文字が入っていても末尾へまとめて残る。
    let mut fields = record.splitn(11, FIELD);
    let sha = fields.next()?;
    let short_sha = fields.next()?;
    let parents = fields.next()?;
    let author_name = fields.next()?;
    let author_email = fields.next()?;
    let author_time = fields.next()?;
    let committer_name = fields.next()?;
    let committer_email = fields.next()?;
    let committer_time = fields.next()?;
    let subject = fields.next()?;
    let body = fields.next().unwrap_or_default();

    if sha.is_empty() {
        return None;
    }

    Some(CommitDetail {
        sha: sha.to_string(),
        short_sha: short_sha.to_string(),
        // ルートコミットは `%P` が空。マージは空白区切りで並ぶ。
        parents: parents.split_whitespace().map(str::to_string).collect(),
        author_name: author_name.to_string(),
        author_email: author_email.to_string(),
        author_time: author_time.trim().parse().unwrap_or_default(),
        committer_name: committer_name.to_string(),
        committer_email: committer_email.to_string(),
        committer_time: committer_time.trim().parse().unwrap_or_default(),
        subject: subject.to_string(),
        // `%b` は末尾に改行が付く。表示側で毎回 trim しなくて済むようここで落とす。
        body: body.trim_end_matches('\n').to_string(),
    })
}

/// `--raw --numstat -z` の出力を分解する。
///
/// **2 種類のレコードが 1 本の NUL 列に連結されて出る**（NUL を `@`、タブを `→` と書く）。
///
/// ```text
/// raw      :<srcmode> <dstmode> <srcsha> <dstsha> <status>@<path>@
/// raw(R)   :<...> R075@<old>@<new>@
/// numstat  <add>→<del>→<path>@
/// numstat  <add>→<del>→@<old>@<new>@     ← リネームはパス欄が空で 2 つ続く
/// numstat  -→-→<path>@                   ← バイナリ
/// ```
///
/// **リネーム / コピーのレコードだけパスを 2 つ食う。** 数え間違えると以降が全部ずれるので、
/// 状態欄を見てから読み進めること。raw 区間が先に来て、`:` で始まらないレコードから
/// numstat 区間に変わる。
fn parse_changes(stdout: &str) -> Vec<FileChange> {
    // 末尾の NUL で必ず空要素が出る。パス名が空になることは無いので落としてよい
    // （リネームの「空のパス欄」はレコードの内側なので、ここでは消えない）。
    let fields: Vec<&str> = stdout.split('\0').filter(|field| !field.is_empty()).collect();

    // raw 区間。状態とファイルモードはここからしか取れない。
    let mut changes: Vec<FileChange> = Vec::new();
    let mut index = 0;
    while index < fields.len() && fields[index].starts_with(':') {
        let Some((change, next)) = parse_raw(&fields, index) else {
            break;
        };
        changes.push(change);
        index = next;
    }

    // numstat 区間。**パスで引き当てる**（並びは raw と同じだが、依存しないほうが安全）。
    let mut counts: HashMap<&str, (Option<u32>, Option<u32>)> = HashMap::new();
    while index < fields.len() {
        let Some((additions, deletions, path, next)) = parse_numstat(&fields, index) else {
            break;
        };
        counts.insert(path, (additions, deletions));
        index = next;
    }

    for change in &mut changes {
        if let Some((additions, deletions)) = counts.get(change.path.as_str()) {
            change.additions = *additions;
            change.deletions = *deletions;
        }
    }
    changes
}

/// raw レコード 1 件と、次のレコードの位置。
fn parse_raw(fields: &[&str], index: usize) -> Option<(FileChange, usize)> {
    // `:100644 100644 6772730 e34b700 M`
    let mut parts = fields[index].trim_start_matches(':').split_whitespace();
    let old_mode = parts.next()?.to_string();
    let new_mode = parts.next()?.to_string();
    let _old_blob = parts.next()?;
    let _new_blob = parts.next()?;
    let status = ChangeStatus::parse(parts.next()?);

    let (old_path, path, next) = if status.takes_two_paths() {
        (
            Some((*fields.get(index + 1)?).to_string()),
            (*fields.get(index + 2)?).to_string(),
            index + 3,
        )
    } else {
        (None, (*fields.get(index + 1)?).to_string(), index + 2)
    };

    Some((
        FileChange {
            path,
            old_path,
            status,
            additions: None,
            deletions: None,
            old_mode,
            new_mode,
        },
        next,
    ))
}

/// numstat レコード 1 件（増減・変更後のパス）と、次のレコードの位置。
fn parse_numstat<'a>(
    fields: &[&'a str],
    index: usize,
) -> Option<(Option<u32>, Option<u32>, &'a str, usize)> {
    let mut parts = fields[index].splitn(3, '\t');
    let additions = count(parts.next()?);
    let deletions = count(parts.next()?);
    let path = parts.next()?;

    if path.is_empty() {
        // リネーム。old は raw 側から取れているので、ここでは new だけ返す。
        Some((additions, deletions, fields.get(index + 2)?, index + 3))
    } else {
        Some((additions, deletions, path, index + 1))
    }
}

/// バイナリでは `-` が出る。数値でなければ「行数が無い」として扱う。
fn count(field: &str) -> Option<u32> {
    field.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::{parse_changes, parse_detail, ChangeStatus};

    /// 実際の `git show -s --format=...` の出力を組み立てる。
    fn detail_record(fields: &[&str]) -> String {
        format!("{}\n", fields.join("\u{1f}"))
    }

    /// 実際の `--raw --numstat -z` の出力を組み立てる。末尾にも NUL が付く。
    fn changes_output(fields: &[&str]) -> String {
        fields
            .iter()
            .map(|field| format!("{field}\0"))
            .collect::<String>()
    }

    #[test]
    fn reads_a_commit_body() {
        let detail = parse_detail(&detail_record(&[
            "0123456789abcdef0123456789abcdef01234567",
            "0123456",
            "aaaa bbbb",
            "作者 太郎",
            "author@example.invalid",
            "1750000000",
            "コミッター 花子",
            "committer@example.invalid",
            "1750000100",
            "要約の行",
            "本文の 1 行目\n本文の 2 行目\n",
        ]))
        .expect("読めるはず");

        assert_eq!(detail.short_sha, "0123456");
        assert_eq!(detail.parents, ["aaaa", "bbbb"]);
        assert_eq!(detail.author_name, "作者 太郎");
        assert_eq!(detail.committer_name, "コミッター 花子");
        assert_eq!(detail.committer_time, 1_750_000_100);
        assert_eq!(detail.subject, "要約の行");
        // 末尾の改行だけが落ち、途中の改行は残る。
        assert_eq!(detail.body, "本文の 1 行目\n本文の 2 行目");
    }

    /// 本文が空でも、subject までは読めなければならない。
    #[test]
    fn reads_a_commit_without_a_body() {
        let detail = parse_detail(&detail_record(&[
            "a", "a", "", "n", "e", "1", "n", "e", "1", "要約だけ", "",
        ]))
        .expect("読めるはず");

        assert!(detail.parents.is_empty(), "ルートコミットは親を持たない");
        assert_eq!(detail.subject, "要約だけ");
        assert_eq!(detail.body, "");
    }

    /// 本文に区切り文字が混ざっても末尾フィールドとして丸ごと残る。
    #[test]
    fn keeps_a_separator_inside_the_body() {
        let detail =
            parse_detail(&detail_record(&["a", "a", "", "n", "e", "1", "n", "e", "1", "s", ""]))
                .expect("読めるはず");
        assert_eq!(detail.subject, "s");

        let odd = parse_detail(
            "a\u{1f}a\u{1f}\u{1f}n\u{1f}e\u{1f}1\u{1f}n\u{1f}e\u{1f}1\u{1f}s\u{1f}前\u{1f}後\n",
        )
        .expect("読めるはず");
        assert_eq!(odd.body, "前\u{1f}後");
    }

    #[test]
    fn empty_output_is_not_a_commit() {
        assert!(parse_detail("").is_none());
        assert!(parse_detail("\n").is_none());
    }

    /// 追加 / 変更 / 削除。もっとも普通の形。
    #[test]
    fn reads_added_modified_and_deleted() {
        let changes = parse_changes(&changes_output(&[
            ":000000 100644 0000000 3e75765 A",
            "added.txt",
            ":100644 100644 587be6b 04ec35a M",
            "changed.txt",
            ":100644 000000 bca70f3 0000000 D",
            "gone.txt",
            "1\t0\tadded.txt",
            "2\t3\tchanged.txt",
            "0\t5\tgone.txt",
        ]));

        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].status, ChangeStatus::Added);
        assert_eq!(changes[0].old_mode, "000000");
        assert_eq!((changes[0].additions, changes[0].deletions), (Some(1), Some(0)));
        assert_eq!(changes[1].status, ChangeStatus::Modified);
        assert_eq!((changes[1].additions, changes[1].deletions), (Some(2), Some(3)));
        assert_eq!(changes[2].status, ChangeStatus::Deleted);
        assert_eq!(changes[2].new_mode, "000000");
    }

    /// **リネームは raw も numstat もパスを 2 つ食う。** ここを取り違えると以降が全部ずれる。
    #[test]
    fn reads_a_rename_without_losing_alignment() {
        let changes = parse_changes(&changes_output(&[
            ":100644 100644 de98044 d68dd40 R075",
            "old.txt",
            "renamed.txt",
            ":100644 100644 587be6b 04ec35a M",
            "after.txt",
            "1\t0\t",
            "old.txt",
            "renamed.txt",
            "9\t9\tafter.txt",
        ]));

        assert_eq!(changes.len(), 2, "リネームの後ろが落ちている");
        assert_eq!(changes[0].status, ChangeStatus::Renamed);
        assert_eq!(changes[0].old_path.as_deref(), Some("old.txt"));
        assert_eq!(changes[0].path, "renamed.txt");
        assert_eq!((changes[0].additions, changes[0].deletions), (Some(1), Some(0)));

        // 後続のファイルが 1 つずれていないこと。
        assert_eq!(changes[1].path, "after.txt");
        assert_eq!((changes[1].additions, changes[1].deletions), (Some(9), Some(9)));
    }

    /// バイナリは増減が `-`。0 行と区別できなければならない。
    #[test]
    fn a_binary_file_has_no_line_counts() {
        let changes = parse_changes(&changes_output(&[
            ":100644 100644 6772730 e34b700 M",
            "blob.bin",
            ":100644 100644 587be6b 04ec35a M",
            "empty-change.txt",
            "-\t-\tblob.bin",
            "0\t0\tempty-change.txt",
        ]));

        assert!(changes[0].is_binary());
        assert_eq!(changes[0].additions, None);
        assert!(!changes[1].is_binary(), "0 行の変更はバイナリではない");
        assert_eq!(changes[1].additions, Some(0));
    }

    /// 日本語ファイル名とサブディレクトリ（`core.quotepath=false` の前提）。
    #[test]
    fn keeps_japanese_paths_unescaped() {
        let changes = parse_changes(&changes_output(&[
            ":100644 100644 587be6b 04ec35a M",
            "ディレクトリ/日本語 ファイル.txt",
            "2\t0\tディレクトリ/日本語 ファイル.txt",
        ]));

        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "ディレクトリ/日本語 ファイル.txt");
        assert_eq!(changes[0].additions, Some(2));
    }

    /// 型変更（通常ファイル ↔ シンボリックリンク）。
    #[test]
    fn reads_a_type_change() {
        let changes = parse_changes(&changes_output(&[
            ":100644 120000 587be6b 04ec35a T",
            "link",
            "1\t1\tlink",
        ]));

        assert_eq!(changes[0].status, ChangeStatus::TypeChanged);
        assert_eq!(changes[0].new_mode, "120000");
    }

    /// 変更が無いコミット（空コミット）。
    #[test]
    fn empty_output_has_no_changes() {
        assert!(parse_changes("").is_empty());
    }

    /// numstat が欠けていても、一覧そのものは出す（行数だけ分からない）。
    #[test]
    fn survives_a_missing_numstat_section() {
        let changes = parse_changes(&changes_output(&[
            ":100644 100644 587be6b 04ec35a M",
            "a.txt",
        ]));

        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].additions, None);
    }
}
