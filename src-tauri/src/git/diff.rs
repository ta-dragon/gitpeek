//! コミット本文と変更ファイル一覧の取得（docs/DESIGN.md §7.3, §7.4 / 付録 A）。
//!
//! 差分の本体（unified diff の取得と hunk へのパース）もここにある（T-13）。
//! **パースを Rust 側に置いたのは改行コードの数え上げのため** — 内容行だけを数える必要が
//! あり、ヘッダ行と内容行を分ける時点でパースそのものだから（docs/DESIGN.md §9.2）。
//!
//! マージコミットの差分は一意に決まらないので、**親は呼び出し側が指定する**
//! （既定は第 1 親 — docs/DESIGN.md §7.4）。`--cc` は v1 では使わない。

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::commandlog::LogSink;
use crate::encoding::{self, LineEnding, LineEndingCounts, TextEncoding};
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
        return Err(output.failure("コミットの中身を読めませんでした"));
    }

    // メッセージの文字コードは git が UTF-8 へ寄せる（commit の encoding ヘッダ）。
    parse_detail(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| format!("コミットの本文を読み取れませんでした: {sha}"))
}

/// コミットメッセージを**そのまま**取る（`%B`）。
///
/// [`commit_detail`] の `subject` + `body` から組み直してはいけない。**`%s` は
/// 最初の段落を 1 行に潰す**ので、要約が複数行にまたがるコミットで改行が消える
/// （`messages` の生成リポジトリで実測）。
///
/// 区切り文字を使わない単一フィールドなので、メッセージに何が入っていても壊れない。
pub fn commit_message(
    log: &dyn LogSink,
    program: &str,
    path: &Path,
    sha: &str,
) -> Result<String, String> {
    let output = exec::run(log, program, Some(path), &["show", "-s", "--format=%B", sha])?;
    if !output.ok() {
        return Err(output.failure("コミットメッセージを読めませんでした"));
    }
    // 文字コードは git が UTF-8 へ寄せる（commit の encoding ヘッダ）。
    // `%B` は末尾に改行が 1 つ付く。
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end_matches('\n')
        .to_string())
}

/// 失敗を人間向けの文にする（CLAUDE.md §6）。
///
/// **共通の祖先が無い 2 点だけは言い換える。** git は `no merge base` としか言わないので、
/// `A...B` を選んだ理由と結び付かない。それ以外はそのまま生の 1 行目を添える。
fn explain(output: &exec::GitOutput, context: &str) -> String {
    if output.stderr.contains("no merge base") {
        return "共通の祖先がありません。関係のない履歴どうしなので、分かれたところからは比べられません。".to_string();
    }
    output.failure(context)
}

/// 何と何を比べるか。
///
/// **コミット同士も作業ツリーもコマンドの組み立てが違うだけ**なので、ここで 1 つにまとめる。
/// 呼び出し側は「何を見たいか」を選ぶだけでよい。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Revisions<'a> {
    /// リビジョン 2 点。**`from` が `None` はルートコミット**（空ツリーとの差分）。
    /// `symmetric` なら `A...B`（マージベース起点。docs/DESIGN.md §10.3）。
    Range {
        from: Option<&'a str>,
        to: &'a str,
        symmetric: bool,
    },
    /// 作業ツリー（docs/DESIGN.md §7.5）。
    /// `staged` なら HEAD と index、そうでなければ index と作業ツリー。
    WorkingTree { staged: bool },
}

impl Revisions<'_> {
    /// ルートコミットは `git diff` では出せない（片側を指定できない）。
    fn is_root_commit(&self) -> bool {
        matches!(
            self,
            Self::Range {
                from: None,
                symmetric: _,
                to: _
            }
        )
    }

    /// リビジョンを指す引数。
    ///
    /// **`A...B` は 1 つの引数として渡す。** `A` と `B` に分けて渡すと、git は
    /// ただの 2 点間差分（`A B`）として扱い、マージベース起点にならない。
    fn args(&self) -> Vec<String> {
        match *self {
            Self::Range {
                from: Some(from),
                to,
                symmetric: true,
            } => vec![format!("{from}...{to}")],
            Self::Range {
                from: Some(from),
                to,
                symmetric: false,
            } => vec![from.to_string(), to.to_string()],
            Self::Range { from: None, to, .. } => vec![to.to_string()],
            // 作業ツリーはリビジョンを指さない（`--cached` の有無で決まる）。
            Self::WorkingTree { .. } => Vec::new(),
        }
    }

    /// `--cached`（HEAD と index を比べる）を付けるか。
    fn cached(&self) -> bool {
        matches!(self, Self::WorkingTree { staged: true })
    }
}

/// フロントから届く「何と何を比べるか」。[`Revisions`] の**持ち主付きの姿**。
///
/// **真偽値を並べるのではなく種類で分ける。** `parent` / `sha` / `symmetric` /
/// 「作業ツリーか」を平らに並べると、成り立たない組み合わせが表現できてしまう。
///
/// **差分ペインとレビューが同じものを指す**ので、型を 2 つ作らない（T-22）。
/// 片方だけワイヤ形式を直すと、もう片方が黙って動かなくなる。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DiffSource {
    /// リビジョン 2 点。`parent` が `None` はルートコミット。
    Range {
        parent: Option<String>,
        sha: String,
        symmetric: bool,
    },
    /// 作業ツリー。`staged` なら HEAD と index、そうでなければ index と作業ツリー。
    WorkingTree { staged: bool },
}

impl DiffSource {
    pub fn revisions(&self) -> Revisions<'_> {
        match self {
            Self::Range {
                parent,
                sha,
                symmetric,
            } => Revisions::Range {
                from: parent.as_deref(),
                to: sha,
                symmetric: *symmetric,
            },
            Self::WorkingTree { staged } => Revisions::WorkingTree { staged: *staged },
        }
    }

    /// 「この 2 点は 1 つのコミットとその親かもしれない」候補（T-22）。
    ///
    /// **ここでは決まらない。** `Range { parent: Some(a), sha: b }` は
    /// 「コミット `b` を親 `a` と比べている」と「無関係な 2 点 `a` `b` を比べている」の
    /// **どちらでも同じ形**なので、実際に親子かどうかは git に聞くしかない
    /// （[`is_parent_of`]）。`parent` が `None` はルートコミットなので、ここで決まる。
    ///
    /// 作業ツリーと `A...B` は候補にもならない。
    pub fn commit_message_candidate(&self) -> Option<(&str, Option<&str>)> {
        match self {
            Self::Range {
                parent,
                sha,
                symmetric: false,
            } => Some((sha, parent.as_deref())),
            _ => None,
        }
    }
}

/// `parent` が `sha` の親のどれかか。**片方でも解決できなければ `false`。**
///
/// 「コミットとその親」と「無関係な 2 点」を言い分けるためだけに使う（T-22）。
/// `rev-list --parents -n 1` は 1 行で `<sha> <親…>` を出すので、これ 1 回で足りる。
pub fn is_parent_of(
    log: &dyn LogSink,
    program: &str,
    repo: &Path,
    parent: &str,
    sha: &str,
) -> bool {
    let Ok(resolved) = exec::run(log, program, Some(repo), &["rev-parse", "--verify", &format!("{parent}^{{commit}}")])
    else {
        return false;
    };
    if !resolved.ok() {
        return false;
    }
    let parent_sha = resolved.stdout_lossy().trim().to_string();

    let Ok(output) = exec::run(log, program, Some(repo), &["rev-list", "--parents", "-n", "1", sha])
    else {
        return false;
    };
    if !output.ok() {
        return false;
    }
    let line = output.stdout_lossy();
    // 先頭は自分自身。2 つ目以降が親。
    line.split_whitespace().skip(1).any(|it| it == parent_sha)
}

/// 変更ファイル一覧を取る。
///
/// **`--raw` と `--numstat` を 1 回の実行で両方出す。** raw から状態とファイルモード、
/// numstat から増減行数とバイナリ判定が取れるので、2 回呼ぶ必要はない。
pub fn changed_files(
    log: &dyn LogSink,
    program: &str,
    path: &Path,
    revisions: Revisions<'_>,
) -> Result<Vec<FileChange>, String> {
    let mut args: Vec<&str> = if revisions.is_root_commit() {
        // `git diff` はルートコミットを片側に取れない。`diff-tree --root` なら
        // 空ツリーとの差分として出せる（`-r` が無いとサブディレクトリを潜らない）。
        vec![
            "diff-tree",
            "--raw",
            "--numstat",
            "-z",
            "-M",
            "--root",
            "--no-commit-id",
            "-r",
        ]
    } else {
        let mut base = vec!["diff"];
        if revisions.cached() {
            base.push("--cached");
        }
        base.extend(["--raw", "--numstat", "-z", "-M"]);
        base
    };

    let revision_args = revisions.args();
    args.extend(revision_args.iter().map(String::as_str));

    let output = exec::run(log, program, Some(path), &args)?;
    if !output.ok() {
        return Err(explain(&output, "変更ファイルの一覧を読めませんでした"));
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
pub(super) fn parse_changes(stdout: &str) -> Vec<FileChange> {
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

/* ---------- 差分本体（T-13） ---------- */

/// 差分 1 行の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKind {
    /// 変わっていない行。両側に出る。
    Context,
    Added,
    Removed,
}

/// 差分の 1 行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    /// 変更前の行番号。追加行では `None`。
    pub old_line: Option<u32>,
    /// 変更後の行番号。削除行では `None`。
    pub new_line: Option<u32>,
    /// **末尾の CR を落とした**本文。行中の CR は残す（CR 単独のファイルは 1 行になる）。
    pub text: String,
    /// この行の改行。**`None` は「ファイル末尾に改行が無い」**
    /// （`\ No newline at end of file` が付いていた）。
    pub ending: Option<LineEnding>,
}

/// hunk 1 つ。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// `@@ ... @@` の後ろ（関数名など）。git が付けなければ空。
    pub heading: String,
    pub lines: Vec<DiffLine>,
}

/// ファイル 1 つ分の差分。
///
/// **モードとリネーム元は持たない。** 呼び出し側は [`FileChange`] で既に持っているので、
/// 差分ヘッダを作るために git を呼び直す必要はない（docs/DESIGN.md §9.3）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    /// `Binary files ... differ` だった。`hunks` は空になる。
    pub binary: bool,
    pub encoding: TextEncoding,
    pub had_bom: bool,
    /// 置換文字が出た。手動上書きを間違えたときの合図。
    pub lossy: bool,
    pub line_endings: LineEndingCounts,
    /// 代表の改行コード。**Rust 側で計算して渡す**（同じ規則を 2 言語で持たない）。
    pub dominant_line_ending: Option<LineEnding>,
    pub mixed_line_endings: bool,
    /// 変更前のバイト数。**バイナリのときだけ入る**（テキストでは常に `None`）。
    /// 追加では片側が無いので `None` になる。**0 と混同しないこと。**
    pub old_size: Option<u64>,
    /// 変更後のバイト数。削除では `None`。
    pub new_size: Option<u64>,
    pub hunks: Vec<Hunk>,
}

/// どのファイルを、何と何の間で見るか。
#[derive(Debug, Clone, Copy)]
pub struct DiffTarget<'a> {
    pub revisions: Revisions<'a>,
    /// 変更後のパス。
    pub path: &'a str,
    /// **リネームのときは必ず入れる**（下記 [`file_diff`] の注意）。
    pub old_path: Option<&'a str>,
}

/// 差分の取り方。画面のトグルがそのまま入る。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiffOptions {
    /// `-U<N>`。既定は `settings.json` の `ui.contextLines`。
    pub context_lines: u32,
    /// `-w`。
    pub ignore_whitespace: bool,
    /// 文字コードの手動上書き。`None` なら自動判別。
    pub encoding: Option<TextEncoding>,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            context_lines: 3,
            ignore_whitespace: false,
            encoding: None,
        }
    }
}

/// ファイル 1 つの差分を取る。
///
/// **リネームでは `old_path` も渡すこと。** pathspec に新しいパスだけを渡すと、
/// git は対になる側が見えずリネームを検出できず、**全行が追加された新規ファイル**として
/// 出る（実測）。
pub fn file_diff(
    log: &dyn LogSink,
    program: &str,
    repo: &Path,
    target: &DiffTarget<'_>,
    options: &DiffOptions,
) -> Result<FileDiff, String> {
    let context = format!("-U{}", options.context_lines);

    let mut args: Vec<&str> = if target.revisions.is_root_commit() {
        // `git diff` はルートコミットを片側に取れない。`-p` が無いと patch が出ない。
        vec![
            "diff-tree",
            "-p",
            "-M",
            &context,
            "--root",
            "--no-commit-id",
            "-r",
        ]
    } else {
        let mut base = vec!["diff"];
        if target.revisions.cached() {
            base.push("--cached");
        }
        base.extend(["-M", &context]);
        base
    };
    if options.ignore_whitespace {
        args.push("-w");
    }
    let revisions = target.revisions.args();
    args.extend(revisions.iter().map(String::as_str));
    args.push("--");
    // リネーム元を先に置く。`--` の後ろは pathspec なので順序は問われない。
    if let Some(old_path) = target.old_path {
        if old_path != target.path {
            args.push(old_path);
        }
    }
    args.push(target.path);

    let output = exec::run(log, program, Some(repo), &args)?;
    if !output.ok() {
        return Err(explain(&output, "差分を読めませんでした"));
    }

    // **ここで文字コードを判別する**（docs/DESIGN.md §9.1）。`stdout_lossy` は使わない。
    Ok(match encoding::decode(&output.stdout, options.encoding) {
        encoding::Decoded::Binary { .. } => {
            let (old_size, new_size) = binary_sizes(log, program, repo, target);
            FileDiff {
                path: target.path.to_string(),
                binary: true,
                encoding: options.encoding.unwrap_or(TextEncoding::Utf8),
                had_bom: false,
                lossy: false,
                line_endings: LineEndingCounts::default(),
                dominant_line_ending: None,
                mixed_line_endings: false,
                old_size,
                new_size,
                hunks: Vec::new(),
            }
        }
        encoding::Decoded::Text(text) => {
            let parsed = parse_patch(&text.text);
            // `Binary files ... differ` は**テキストとして読めた**うえで出てくる。
            let (old_size, new_size) = if parsed.binary {
                binary_sizes(log, program, repo, target)
            } else {
                (None, None)
            };
            FileDiff {
                path: target.path.to_string(),
                binary: parsed.binary,
                encoding: text.encoding,
                had_bom: text.had_bom,
                lossy: text.lossy,
                line_endings: parsed.line_endings,
                dominant_line_ending: parsed.line_endings.dominant(),
                mixed_line_endings: parsed.line_endings.mixed(),
                old_size,
                new_size,
                hunks: parsed.hunks,
            }
        }
    })
}

/// バイナリの前後のバイト数を取る（docs/DESIGN.md §7.2）。
///
/// **バイナリのときだけ呼ぶこと。** テキストでは行数が出るので要らないうえ、
/// 1 ファイルにつき git を 2 回余分に叩くことになる。
///
/// `cat-file -s` ではなく `ls-tree -l` を使う。無いパス（追加や削除の反対側）を
/// `cat-file` に渡すと**失敗として記録される**が、`ls-tree` は空を返して成功するため。
fn binary_sizes(
    log: &dyn LogSink,
    program: &str,
    repo: &Path,
    target: &DiffTarget<'_>,
) -> (Option<u64>, Option<u64>) {
    // **作業ツリーではサイズを出さない。** index と作業ツリーのバイト数は
    // `ls-tree` では引けず、片側だけ正しい数を出すと嘘になる。
    let Revisions::Range { from, to, .. } = target.revisions else {
        return (None, None);
    };

    let old_path = target.old_path.unwrap_or(target.path);
    let old_size = from.and_then(|from| blob_size(log, program, repo, from, old_path));
    let new_size = blob_size(log, program, repo, to, target.path);
    (old_size, new_size)
}

/// そのリビジョンにあるファイルのバイト数。無ければ `None`。
fn blob_size(
    log: &dyn LogSink,
    program: &str,
    repo: &Path,
    rev: &str,
    path: &str,
) -> Option<u64> {
    let output = exec::run(
        log,
        program,
        Some(repo),
        &["ls-tree", "-l", "-z", rev, "--", path],
    )
    .ok()?;
    if !output.ok() {
        return None;
    }

    // `<mode> <type> <object> <size>` のあとにタブとパスが続く。パスは要らない。
    let record = String::from_utf8_lossy(&output.stdout);
    let head = record.split('\0').next()?;
    let size = head.split_whitespace().nth(3)?;
    size.parse().ok()
}

/// パースの結果。改行の集計は**内容行だけ**を対象にする。
struct ParsedPatch {
    hunks: Vec<Hunk>,
    binary: bool,
    line_endings: LineEndingCounts,
}

/// unified diff を hunk に分解する。
///
/// 見るのは `@@` 以降だけ。`diff --git` や `index` などのヘッダ行は読み飛ばす
/// （必要な情報は [`FileChange`] 側に揃っている）。
///
/// **改行コードの集計はヘッダ行を含めない。** diff のヘッダは常に LF なので、
/// 混ぜると CRLF のファイルが全部「混在」になる（docs/DESIGN.md §9.2）。
fn parse_patch(patch: &str) -> ParsedPatch {
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut binary = false;
    // 新しい側（context + added）と古い側を別々に数え、あとでどちらかを採る。
    let mut new_side = LineEndingCounts::default();
    let mut old_side = LineEndingCounts::default();

    let mut old_line = 0u32;
    let mut new_line = 0u32;

    // 末尾の改行で必ず空要素が出る。そのまま回すと偽の空行が 1 件増える。
    for raw in patch.strip_suffix('\n').unwrap_or(patch).split('\n') {
        // `Binary files a/x and b/x differ` / `GIT binary patch`
        if hunks.is_empty() && (raw.starts_with("Binary files ") || raw.starts_with("GIT binary patch")) {
            binary = true;
            continue;
        }

        if raw.starts_with("@@") {
            if let Some(header) = parse_hunk_header(raw) {
                old_line = header.old_start;
                new_line = header.new_start;
                hunks.push(header.hunk);
            }
            continue;
        }

        // hunk に入るまでのヘッダ行（`--- a/x` などが `-` で始まる）は読み飛ばす。
        let Some(hunk) = hunks.last_mut() else {
            continue;
        };

        // `\ No newline at end of file` は**直前の行に付く印**であり、行ではない。
        if raw.starts_with('\\') {
            if let Some(line) = hunk.lines.last_mut() {
                let side = match line.kind {
                    DiffLineKind::Removed => &mut old_side,
                    _ => &mut new_side,
                };
                // 数えてしまった改行を取り消す。
                match line.ending {
                    Some(LineEnding::Crlf) => side.crlf = side.crlf.saturating_sub(1),
                    Some(LineEnding::Lf) => side.lf = side.lf.saturating_sub(1),
                    Some(LineEnding::Cr) | None => {}
                }
                line.ending = None;
            }
            continue;
        }

        let (kind, body) = match raw.as_bytes().first() {
            Some(b' ') => (DiffLineKind::Context, &raw[1..]),
            Some(b'+') => (DiffLineKind::Added, &raw[1..]),
            Some(b'-') => (DiffLineKind::Removed, &raw[1..]),
            // 空行は「空のコンテキスト行」。git は通常 " " を出すが、
            // 末尾の split で必ず 1 件出るので、そこで hunk を壊さないように受けておく。
            None => (DiffLineKind::Context, raw),
            // hunk の後ろに次のファイルのヘッダが続く場合（pathspec を 2 つ渡したとき）。
            _ => continue,
        };

        // 末尾の CR は CRLF の名残。**本文からは落とす**（画面に制御文字を出さない）。
        let (text, ending) = match body.strip_suffix('\r') {
            Some(stripped) => (stripped, LineEnding::Crlf),
            None => (body, LineEnding::Lf),
        };
        // 行中に残る CR は「CR だけで改行しているファイル」。git は 1 行として出す。
        let inner_cr = text.matches('\r').count() as u32;

        let side = match kind {
            DiffLineKind::Removed => &mut old_side,
            _ => &mut new_side,
        };
        match ending {
            LineEnding::Crlf => side.crlf += 1,
            _ => side.lf += 1,
        }
        side.cr += inner_cr;

        let (old_no, new_no) = match kind {
            DiffLineKind::Context => {
                let pair = (Some(old_line), Some(new_line));
                old_line += 1;
                new_line += 1;
                pair
            }
            DiffLineKind::Added => {
                let pair = (None, Some(new_line));
                new_line += 1;
                pair
            }
            DiffLineKind::Removed => {
                let pair = (Some(old_line), None);
                old_line += 1;
                pair
            }
        };

        hunk.lines.push(DiffLine {
            kind,
            old_line: old_no,
            new_line: new_no,
            text: text.to_string(),
            ending: Some(ending),
        });
    }

    // **新しい側で数える。** 画面のステータスは「今このファイルがどうなっているか」を
    // 指すため。削除だけの差分（ファイルごと消えた）では新しい側が空なので古い側を採る。
    let line_endings = if new_side == LineEndingCounts::default() {
        old_side
    } else {
        new_side
    };

    ParsedPatch {
        hunks,
        binary,
        line_endings,
    }
}

struct HunkHeader {
    hunk: Hunk,
    old_start: u32,
    new_start: u32,
}

/// `@@ -12,7 +12,9 @@ fn main()` を読む。
///
/// 1 行だけの側は個数が省略される（`-1 +1,2`）。省略時は 1 件。
fn parse_hunk_header(line: &str) -> Option<HunkHeader> {
    let rest = line.strip_prefix("@@ ")?;
    let (ranges, heading) = match rest.split_once(" @@") {
        Some((ranges, heading)) => (ranges, heading.strip_prefix(' ').unwrap_or(heading)),
        None => return None,
    };

    let mut parts = ranges.split_whitespace();
    let (old_start, old_lines) = parse_range(parts.next()?.strip_prefix('-')?)?;
    let (new_start, new_lines) = parse_range(parts.next()?.strip_prefix('+')?)?;

    Some(HunkHeader {
        hunk: Hunk {
            old_start,
            old_lines,
            new_start,
            new_lines,
            heading: heading.to_string(),
            lines: Vec::new(),
        },
        old_start,
        new_start,
    })
}

/// `12,7` または `12`。
fn parse_range(field: &str) -> Option<(u32, u32)> {
    match field.split_once(',') {
        Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
        None => Some((field.parse().ok()?, 1)),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        parse_changes, parse_detail, parse_patch, ChangeStatus, DiffLineKind, LineEnding,
        LineEndingCounts,
    };

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

    /* ---------- 差分本体のパース（T-13） ---------- */

    /// 変更 1 件。**行番号が hunk の開始位置から数えられていること**を見る。
    #[test]
    fn parses_a_single_hunk() {
        let patch = r#"diff --git a/f.txt b/f.txt
index 422c2b7..33d5d3b 100644
--- a/f.txt
+++ b/f.txt
@@ -10,3 +10,4 @@ fn main()
 a
-b
+B
+c
"#;
        let parsed = parse_patch(patch);

        assert_eq!(parsed.hunks.len(), 1);
        let hunk = &parsed.hunks[0];
        assert_eq!(hunk.old_start, 10);
        assert_eq!(hunk.old_lines, 3);
        assert_eq!(hunk.new_start, 10);
        assert_eq!(hunk.new_lines, 4);
        assert_eq!(hunk.heading, "fn main()");

        let shape: Vec<(DiffLineKind, Option<u32>, Option<u32>, &str)> = hunk
            .lines
            .iter()
            .map(|line| {
                (
                    line.kind,
                    line.old_line,
                    line.new_line,
                    line.text.as_str(),
                )
            })
            .collect();
        assert_eq!(
            shape,
            vec![
                (DiffLineKind::Context, Some(10), Some(10), "a"),
                (DiffLineKind::Removed, Some(11), None, "b"),
                (DiffLineKind::Added, None, Some(11), "B"),
                (DiffLineKind::Added, None, Some(12), "c"),
            ]
        );
    }

    /// **`---` / `+++` のヘッダ行を内容行として数えないこと。**
    /// hunk に入る前は `-` `+` で始まる行が出る。
    #[test]
    fn header_lines_are_not_content() {
        let patch = r#"diff --git a/f.txt b/f.txt
new file mode 100644
index 0000000..3e75765
--- /dev/null
+++ b/f.txt
@@ -0,0 +1,2 @@
+one
+two
"#;
        let parsed = parse_patch(patch);
        assert_eq!(parsed.hunks.len(), 1);
        assert_eq!(parsed.hunks[0].lines.len(), 2);
        assert!(parsed.hunks[0]
            .lines
            .iter()
            .all(|line| line.kind == DiffLineKind::Added));
    }

    #[test]
    fn parses_a_deletion_only_hunk() {
        let patch = r#"diff --git a/f.txt b/f.txt
deleted file mode 100644
index d00491f..0000000
--- a/f.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-x
-y
"#;
        let parsed = parse_patch(patch);
        let lines = &parsed.hunks[0].lines;
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].old_line, Some(1));
        assert_eq!(lines[1].old_line, Some(2));
        assert!(lines.iter().all(|line| line.new_line.is_none()));
    }

    /// 複数 hunk。**2 つ目の行番号が 1 つ目の続きではなくヘッダから始まること。**
    #[test]
    fn parses_multiple_hunks() {
        let patch = r#"--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
 a
-b
+B
@@ -20,2 +20,2 @@ tail
 y
-z
+Z
"#;
        let parsed = parse_patch(patch);

        assert_eq!(parsed.hunks.len(), 2);
        assert_eq!(parsed.hunks[1].lines[0].old_line, Some(20));
        assert_eq!(parsed.hunks[1].heading, "tail");
    }

    /// 個数が省略された hunk ヘッダ（`-1 +1,2`）は 1 件として読む。
    #[test]
    fn hunk_header_without_counts() {
        let patch = r#"@@ -1 +1,2 @@
-a
+a
+b
"#;
        let parsed = parse_patch(patch);
        assert_eq!(parsed.hunks[0].old_lines, 1);
        assert_eq!(parsed.hunks[0].new_lines, 2);
    }

    /// `\ No newline at end of file` は**直前の行に付く印**であり、行ではない。
    #[test]
    fn no_newline_marker_is_not_a_line() {
        let patch = r#"@@ -1,2 +1,2 @@
 a
-b
+B
\ No newline at end of file
"#;
        let parsed = parse_patch(patch);

        assert_eq!(parsed.hunks[0].lines.len(), 3);
        let last = parsed.hunks[0].lines.last().unwrap();
        assert_eq!(last.text, "B");
        assert_eq!(last.ending, None);
        // 印の付いた行のぶんを数え直していること（context の 1 件だけが残る）。
        assert_eq!(parsed.line_endings.lf, 1);
    }

    #[test]
    fn binary_files_have_no_hunks() {
        let patch = r#"diff --git a/blob.bin b/blob.bin
index e158ec5..00f8da4 100644
Binary files a/blob.bin and b/blob.bin differ
"#;
        let parsed = parse_patch(patch);
        assert!(parsed.binary);
        assert!(parsed.hunks.is_empty());
    }

    /// 内容の変わらないリネームやモード変更だけの差分。**エラーにしない。**
    #[test]
    fn rename_without_content_change_has_no_hunks() {
        let patch = r#"diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
"#;
        let parsed = parse_patch(patch);
        assert!(parsed.hunks.is_empty());
        assert!(!parsed.binary);
    }

    #[test]
    fn empty_patch_is_empty() {
        let parsed = parse_patch("");
        assert!(parsed.hunks.is_empty());
        assert_eq!(parsed.line_endings, LineEndingCounts::default());
    }

    /// モード変更（`100644` → `100755`）でヘッダが増えても内容行を取り違えない。
    #[test]
    fn mode_change_header_is_skipped() {
        let patch = r#"diff --git a/s.sh b/s.sh
old mode 100644
new mode 100755
index 1111111..2222222
--- a/s.sh
+++ b/s.sh
@@ -1,1 +1,1 @@
-echo old
+echo new
"#;
        let parsed = parse_patch(patch);
        assert_eq!(parsed.hunks[0].lines.len(), 2);
        assert_eq!(parsed.hunks[0].lines[0].text, "echo old");
    }

    /// シンボリックリンクは中身がリンク先 1 行になる（型変更のヘッダは読み飛ばす）。
    #[test]
    fn symlink_content_is_the_target_path() {
        let patch = r#"diff --git a/link b/link
new file mode 120000
index 0000000..3333333
--- /dev/null
+++ b/link
@@ -0,0 +1 @@
+../target/file
\ No newline at end of file
"#;
        let parsed = parse_patch(patch);
        assert_eq!(parsed.hunks[0].lines[0].text, "../target/file");
        assert_eq!(parsed.hunks[0].lines[0].ending, None);
    }

    /// CRLF のファイル。**CR を本文に残さず、改行コードとして数える。**
    #[test]
    fn crlf_lines_are_counted_not_shown() {
        // 生の CR を含む patch を組み立てる（raw 文字列には書けない）。
        let cr = '\u{0d}';
        let patch = format!(
            "@@ -1,2 +1,2 @@\n a{cr}\n-b{cr}\n+B{cr}\n",
        );
        let parsed = parse_patch(&patch);

        let lines = &parsed.hunks[0].lines;
        assert_eq!(lines[0].text, "a", "本文に CR を残さないこと");
        assert_eq!(lines[0].ending, Some(LineEnding::Crlf));
        // 新しい側（context + added）だけを数える。
        assert_eq!(
            parsed.line_endings,
            LineEndingCounts {
                lf: 0,
                crlf: 2,
                cr: 0
            }
        );
        assert!(!parsed.line_endings.mixed());
    }

    /// LF と CRLF の混在。**警告を出す根拠になるので、ここは落とせない。**
    #[test]
    fn mixed_line_endings_are_detected() {
        let cr = '\u{0d}';
        let patch = format!("@@ -1,2 +1,2 @@\n a\n+B{cr}\n");
        let parsed = parse_patch(&patch);

        assert_eq!(
            parsed.line_endings,
            LineEndingCounts {
                lf: 1,
                crlf: 1,
                cr: 0
            }
        );
        assert!(parsed.line_endings.mixed());
    }

    /// 削除だけの差分（ファイルごと消えた）では、古い側の改行を数える。
    #[test]
    fn deletion_only_counts_the_old_side() {
        let cr = '\u{0d}';
        let patch = format!("@@ -1,2 +0,0 @@\n-x{cr}\n-y{cr}\n");
        let parsed = parse_patch(&patch);

        assert_eq!(parsed.line_endings.crlf, 2);
        assert_eq!(parsed.line_endings.dominant(), Some(LineEnding::Crlf));
    }

}
