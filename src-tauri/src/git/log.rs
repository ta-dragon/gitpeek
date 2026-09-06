//! `git log` の実行と `--format` 出力のパース。
//!
//! **`--all` を使ってはいけない**（CLAUDE.md §2, docs/DESIGN.md §4.2）。
//! `--all` は `refs/tags/`・`refs/stash`・`refs/notes/` まで起点に含めるため、
//! 「タグを起点 ref にしない」という決定に違反する。起点は
//! `--branches`（`refs/heads/*`）・`--remotes`（`refs/remotes/*`）・HEAD の 3 つだけ。

use std::path::Path;
use std::time::Instant;

use crate::commandlog::LogSink;
use crate::git::exec;
use crate::git::progress::{LoadPhase, Reporting};
use crate::model::CommitMeta;

/// フィールド区切り（Unit Separator）。コミットメッセージにまず現れない。
const FIELD: char = '\u{1f}';

/// `git log` の書式。**`git log` では `%x1f` が 0x1F に展開される**
/// （`for-each-ref` は書式言語が別で `%1f` になる。[`super::refs`] を見ること）。
///
/// subject（`%s`）を最後に置くのは、区切り文字を含んでいても末尾フィールドとして
/// 丸ごと残せるようにするため。
const FORMAT: &str = "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%s";

/// 途中経過を報告する間隔。
///
/// 300MB を 64KB ずつ読むと 5000 回近く呼ばれる。毎回イベントを送ると、
/// 進捗の表示自体が読み込みより重くなる。
const REPORT_INTERVAL_MS: u128 = 150;

/// 起点 ref から到達できる全コミットのメタ情報を topo-order で取得する。
///
/// `include_head` は HEAD がコミットを指しているときだけ `true` にすること。
/// コミット 0 件のリポジトリに `HEAD` を渡すと
/// `fatal: ambiguous argument 'HEAD'` で全体が失敗する。
///
/// 読みながら NUL（レコード区切り）を数えて `progress` に件数を流す。
pub fn load(
    log: &dyn LogSink,
    program: &str,
    path: &Path,
    include_head: bool,
    reporting: &Reporting<'_>,
) -> Result<Vec<CommitMeta>, String> {
    let mut args = vec!["log", "--branches", "--remotes"];
    if include_head {
        args.push("HEAD");
    }
    // `-z` はレコード区切りを NUL にする。改行を含むメッセージでも行が割れない。
    args.extend_from_slice(&["--topo-order", "-z", FORMAT]);

    let mut seen = 0_u64;
    let mut last_report = Instant::now();
    let output = exec::run_streaming(log, program, Some(path), &args, &mut |chunk| {
        // レコードは NUL 終端。数えるだけならパースを待たなくてよい。
        seen += bytecount(chunk, 0);
        if last_report.elapsed().as_millis() >= REPORT_INTERVAL_MS {
            last_report = Instant::now();
            reporting.report(LoadPhase::Commits, seen);
        }
    })?;
    if !output.ok() {
        return Err(output.failure("コミットの一覧を読めませんでした"));
    }

    // メッセージの文字コードは git が UTF-8 へ寄せてくれる（commit の encoding ヘッダ）。
    // ヘッダの無い非 UTF-8 コミットは化けるが、v1 では置換文字のまま表示する。
    Ok(parse(&String::from_utf8_lossy(&output.stdout)))
}

fn bytecount(haystack: &[u8], needle: u8) -> u64 {
    haystack.iter().filter(|byte| **byte == needle).count() as u64
}

/// `-z` 付き `git log` の出力を分解する。壊れたレコードは黙って飛ばす。
pub fn parse(stdout: &str) -> Vec<CommitMeta> {
    stdout.split('\0').filter_map(parse_record).collect()
}

fn parse_record(record: &str) -> Option<CommitMeta> {
    // レコードの前後に残る改行を落とす。subject 内の改行には触らない。
    let record = record.trim_matches('\n');
    if record.is_empty() {
        return None;
    }

    // 8 分割。subject に区切り文字が入っていても末尾へまとめて残る。
    let mut fields = record.splitn(8, FIELD);
    let sha = fields.next()?;
    let short_sha = fields.next()?;
    let parents = fields.next()?;
    let author_name = fields.next()?;
    let author_email = fields.next()?;
    let author_time = fields.next()?;
    let commit_time = fields.next()?;
    let subject = fields.next()?;

    if sha.is_empty() {
        return None;
    }

    Some(CommitMeta {
        sha: sha.to_string(),
        short_sha: short_sha.to_string(),
        // ルートコミットは `%P` が空。マージは空白区切りで並ぶ。
        parents: parents.split_whitespace().map(str::to_string).collect(),
        author_name: author_name.to_string(),
        author_email: author_email.to_string(),
        author_time: author_time.trim().parse().unwrap_or_default(),
        commit_time: commit_time.trim().parse().unwrap_or_default(),
        subject: subject.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::parse;

    /// 実際の `git log -z --format=...` の出力を組み立てる。
    fn record(fields: &[&str]) -> String {
        format!("{}\0", fields.join("\u{1f}"))
    }

    #[test]
    fn parses_a_plain_commit() {
        let stdout = record(&[
            "6f94eac3aa163a7772dc8cb76ecf78adee379dfc",
            "6f94eac",
            "5c5897f6b4e4f68b7f5e638ef95bd13bef608726",
            "GitPeek Test",
            "test@example.invalid",
            "1767225600",
            "1767225601",
            "最初のコミット",
        ]);

        let commits = parse(&stdout);
        assert_eq!(commits.len(), 1);
        let commit = &commits[0];
        assert_eq!(commit.sha, "6f94eac3aa163a7772dc8cb76ecf78adee379dfc");
        assert_eq!(commit.short_sha, "6f94eac");
        assert_eq!(commit.parents, ["5c5897f6b4e4f68b7f5e638ef95bd13bef608726"]);
        assert_eq!(commit.author_name, "GitPeek Test");
        assert_eq!(commit.author_time, 1767225600);
        assert_eq!(commit.commit_time, 1767225601);
        // 日本語が 8 進エスケープされずに戻ること（core.quotepath=false の効果）。
        assert_eq!(commit.subject, "最初のコミット");
    }

    #[test]
    fn parses_an_empty_subject() {
        let stdout = record(&["a".repeat(40).as_str(), "aaaaaaa", "", "N", "e", "1", "2", ""]);
        let commits = parse(&stdout);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "");
        // ルートコミットは親を持たない。
        assert!(commits[0].parents.is_empty());
    }

    #[test]
    fn parses_multiple_parents() {
        let stdout = record(&[
            "111a8d0000000000000000000000000000000000",
            "111a8d0",
            "5c5897f0000000000000000000000000000000000 331b5570000000000000000000000000000000000 5a776100000000000000000000000000000000000",
            "N",
            "e",
            "1",
            "2",
            "Merge branches 'leg-1' and 'leg-2'",
        ]);

        let commits = parse(&stdout);
        // オクトパスマージ（親 3 つ）。第一親が先頭に来る。
        assert_eq!(commits[0].parents.len(), 3);
        assert!(commits[0].parents[0].starts_with("5c5897f"));
    }

    #[test]
    fn parses_a_signed_commit() {
        // 署名は `--format` の出力形状を変えない（gpgsig はヘッダにしか出ない）。
        // 署名付きリポジトリを CI で生成できないので、実出力を固定文字列で持つ。
        let stdout = record(&[
            "cafe000000000000000000000000000000000000",
            "cafe000",
            "beef000000000000000000000000000000000000",
            "Signed Author",
            "signed@example.invalid",
            "1767225600",
            "1767225600",
            "署名付きのコミット",
        ]);

        let commits = parse(&stdout);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "署名付きのコミット");
    }

    #[test]
    fn keeps_records_separated_when_the_message_contains_newlines() {
        // `%s` は本文を含まないが、改行がそのまま来ても `-z` のレコードは割れない。
        let stdout = format!(
            "{}{}",
            record(&["a".repeat(40).as_str(), "aaaaaaa", "", "N", "e", "1", "2", "1 行目\n2 行目"]),
            record(&["b".repeat(40).as_str(), "bbbbbbb", "", "N", "e", "3", "4", "次のコミット"]),
        );

        let commits = parse(&stdout);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "1 行目\n2 行目");
        assert_eq!(commits[1].subject, "次のコミット");
    }

    #[test]
    fn keeps_a_separator_inside_the_subject() {
        // subject が区切り文字を含んでいても、後続フィールドとして食われない。
        let stdout = record(&["a".repeat(40).as_str(), "aaaaaaa", "", "N", "e", "1", "2", "a\u{1f}b"]);
        assert_eq!(parse(&stdout)[0].subject, "a\u{1f}b");
    }

    #[test]
    fn ignores_incomplete_records() {
        // 末尾 NUL による空レコード、フィールド不足、空 SHA は落とす。
        assert!(parse("").is_empty());
        assert!(parse("\0\0").is_empty());
        assert!(parse(&record(&["sha", "short", ""])).is_empty());
        assert!(parse(&record(&["", "s", "", "N", "e", "1", "2", "x"])).is_empty());
    }

    #[test]
    fn tolerates_a_missing_trailing_nul() {
        let one = record(&["a".repeat(40).as_str(), "aaaaaaa", "", "N", "e", "1", "2", "x"]);
        assert_eq!(parse(one.trim_end_matches('\0')).len(), 1);
    }
}
