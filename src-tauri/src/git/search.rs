//! コミットを探す（T-35。docs/DESIGN.md §6.6）。
//!
//! **起点 ref は全件取得と同じ**（`--branches --remotes HEAD`）。`--all` を使わない
//! 理由は §4.2（CLAUDE.md §2）。タグだけが指すコミットには当たらない。
//!
//! **フロントから git のフラグを受け取らない。** 受け取るのは [`CommitQuery`] だけで、
//! 引数の組み立てはここでやる（CLAUDE.md §4）。値は `--grep=<v>` のように
//! **1 引数の形**で渡すので、`-` で始まる値がフラグとして食われない。
//!
//! **メッセージと作者を手元で探さない。** 一覧が持っているのは `%s`（要約 1 行）だけで、
//! 本文に書いた語が黙って当たらなくなる。git に聞いても onyx（20,285 コミット）で
//! 0.2 秒なので、速さのために正しさを落とす理由が無い（§6.6 の実測）。

use std::collections::HashSet;
use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::commandlog::LogSink;
use crate::git::exec;

/// SHA と作者を NUL 区切りで出す。本文は取らない。
///
/// 作者まで取るのは、**git に頼めない絞り込みが 1 つだけある**ため（[`Run::author_contains`]）。
const FORMAT: &str = "--format=%H%x1f%an%x1f%ae";

/// フィールド区切り（Unit Separator）。[`super::log`] と同じ。
const FIELD: char = '\u{1f}';

/// 探すことば。**どれも空なら実行しない。**
///
/// `any` は指定語なしで打たれたことばで、**メッセージ または 作者**から探す。
/// git は `--grep` と `--author` を必ず AND するので、この OR は 1 回では書けない
/// （[`runs`] が 2 回に割る）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitQuery {
    pub any: Option<String>,
    pub message: Option<String>,
    pub author: Option<String>,
    /// コード内容（`log -S`）。**書かれたときだけ**探す。
    pub code: Option<String>,
}

impl CommitQuery {
    /// 探すことばが 1 つも無いか。**空白だけの値は無いものとして扱う。**
    pub fn is_empty(&self) -> bool {
        [&self.any, &self.message, &self.author, &self.code]
            .into_iter()
            .all(|value| value.as_deref().map(str::trim).unwrap_or("").is_empty())
    }
}

/// 探した結果。
///
/// **並びに意味を持たせない。** 画面での順は行の並び（`LaneLayout.rows`）が決めるので、
/// ここでは重複だけを落として返す。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSearchOutcome {
    pub shas: Vec<String>,
    pub elapsed_ms: u64,
}

/// 実行 1 回ぶん。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub args: Vec<String>,
    /// git に頼めなかったぶんの絞り込み。作者（`名前 <メール>`）にこの文字列を
    /// 含むものだけを残す。**大文字小文字は区別しない。**
    ///
    /// **git は同じヘッダへの複数パターンを OR する。** `--grep` を 2 つ並べたときは
    /// `--all-match` で AND になるのに、**`--author` を 2 つ並べると `--all-match` を
    /// 付けても OR のまま**で、「どちらの作者でもよい」になってしまう。作者を 2 つ
    /// 求める回だけ、片方を git に渡さずここで見る（docs/DESIGN.md §17.1）。
    pub author_contains: Option<String>,
}

/// 実行 1 回ぶんの引数を組み立てる。
///
/// **`any` があると 2 回に割れる** — 1 回目は `--grep`、2 回目は `--author` として当て、
/// 呼び出し側で和を取る。`code` は**どちらにも載せる**。載せないと pickaxe が
/// 全コミットぶんの差分を取ることになり、onyx で 5.9 秒が 17.1 秒になる（§6.6）。
///
/// **`--grep` を 2 つ以上並べると git は OR する。** AND にするため、grep 系の
/// パターンが 2 つ以上あるときは `--all-match` を付ける（`--author` との AND は
/// 既定の挙動で、`--all-match` を足しても変わらないことを確かめてある）。
/// **同じヘッダへの 2 つは OR のまま**なので、そこだけ [`Run::author_contains`] で絞る。
pub fn runs(query: &CommitQuery, include_head: bool) -> Vec<Run> {
    let text = |value: &Option<String>| -> Option<String> {
        let trimmed = value.as_deref().unwrap_or("").trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    };

    let any = text(&query.any);
    let message = text(&query.message);
    let author = text(&query.author);
    let code = text(&query.code);

    // `any` をメッセージ側に当てる回と、作者側に当てる回。無ければ 1 回だけ。
    let variants: Vec<(Option<String>, Option<String>)> = match &any {
        None => vec![(None, None)],
        Some(word) => vec![(Some(word.clone()), None), (None, Some(word.clone()))],
    };

    variants
        .into_iter()
        .map(|(any_message, any_author)| {
            // 作者を 2 つ求める回。git は OR してしまうので、`any` のほうは渡さず
            // 取ってきた作者で絞る。片方しか無いときは git に任せる。
            let (author_pattern, author_contains) = match (&author, &any_author) {
                (Some(named), Some(word)) => (Some(named.clone()), Some(word.clone())),
                (named, word) => (named.clone().or_else(|| word.clone()), None),
            };

            let mut greps: Vec<String> = Vec::new();
            for value in [&message, &any_message].into_iter().flatten() {
                greps.push(format!("--grep={value}"));
            }
            if let Some(value) = &author_pattern {
                greps.push(format!("--author={value}"));
            }

            let mut args: Vec<String> = vec!["log".into(), "--branches".into(), "--remotes".into()];
            // コミット 0 件のリポジトリに `HEAD` を渡すと git log 全体が失敗する。
            if include_head {
                args.push("HEAD".into());
            }
            args.extend([
                "--topo-order".into(),
                "-z".into(),
                FORMAT.into(),
                // 大文字小文字を区別しない。**`-S` にも効く**（§6.6。テストで固定してある）。
                "-i".into(),
                // 打った文字をそのまま探す（正規表現として解釈しない）。
                "-F".into(),
            ]);
            if greps.len() >= 2 {
                args.push("--all-match".into());
            }
            args.extend(greps);
            if let Some(value) = &code {
                args.push(format!("-S{value}"));
            }
            Run {
                args,
                author_contains,
            }
        })
        .collect()
}

/// 当たったコミット 1 件ぶん。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub sha: String,
    /// `名前 <メール>`。git の `--author` が見ているのと同じ形にそろえてある。
    pub author: String,
}

/// `-z --format=%H%x1f%an%x1f%ae` の出力を分解する。**壊れたレコードは飛ばす。**
pub fn parse(stdout: &str) -> Vec<Found> {
    stdout
        .split('\0')
        .filter_map(|record| {
            let record = record.trim_matches('\n');
            let mut fields = record.splitn(3, FIELD);
            let sha = fields.next()?.trim();
            if sha.is_empty() {
                return None;
            }
            let name = fields.next().unwrap_or_default();
            let mail = fields.next().unwrap_or_default();
            Some(Found {
                sha: sha.to_string(),
                author: format!("{name} <{mail}>"),
            })
        })
        .collect()
}

/// 探して、当たったコミットの SHA を返す。
pub fn search(
    log: &dyn LogSink,
    program: &str,
    path: &Path,
    query: &CommitQuery,
    include_head: bool,
) -> Result<CommitSearchOutcome, String> {
    if query.is_empty() {
        return Err("探すことばがありません".to_string());
    }

    let started = Instant::now();
    let mut shas: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for run in runs(query, include_head) {
        let borrowed: Vec<&str> = run.args.iter().map(String::as_str).collect();
        let output = exec::run_streaming(log, program, Some(path), &borrowed, &mut |_chunk| {})?;
        if !output.ok() {
            return Err(output.failure("コミットを探せませんでした"));
        }
        let narrow = run.author_contains.map(|word| word.to_lowercase());
        for found in parse(&String::from_utf8_lossy(&output.stdout)) {
            if let Some(word) = &narrow {
                if !found.author.to_lowercase().contains(word.as_str()) {
                    continue;
                }
            }
            if seen.insert(found.sha.clone()) {
                shas.push(found.sha);
            }
        }
    }

    Ok(CommitSearchOutcome {
        shas,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::{parse, runs, CommitQuery};

    fn query(any: &str, message: &str, author: &str, code: &str) -> CommitQuery {
        let some = |value: &str| (!value.is_empty()).then(|| value.to_string());
        CommitQuery {
            any: some(any),
            message: some(message),
            author: some(author),
            code: some(code),
        }
    }

    fn args_of(query: &CommitQuery) -> Vec<Vec<String>> {
        runs(query, true).into_iter().map(|run| run.args).collect()
    }

    fn has(args: &[String], value: &str) -> bool {
        args.iter().any(|arg| arg == value)
    }

    #[test]
    fn a_bare_word_is_asked_twice() {
        // git は `--grep` と `--author` を AND するので、「メッセージ または 作者」は
        // 1 回では書けない。
        let built = args_of(&query("ほげ", "", "", ""));
        assert_eq!(built.len(), 2);
        assert!(has(&built[0], "--grep=ほげ"));
        assert!(has(&built[1], "--author=ほげ"));
        // 片方にしか当てていないので `--all-match` は要らない。
        assert!(!has(&built[0], "--all-match"));
    }

    #[test]
    fn named_words_are_asked_once() {
        let built = args_of(&query("", "直す", "tatsu", ""));
        assert_eq!(built.len(), 1);
        assert!(has(&built[0], "--grep=直す"));
        assert!(has(&built[0], "--author=tatsu"));
        // grep 系が 2 つ並ぶので AND にする。付けないと OR になる。
        assert!(has(&built[0], "--all-match"));
    }

    #[test]
    fn two_authors_are_not_both_given_to_git() {
        // **git は同じヘッダへの 2 つのパターンを OR する**（`--all-match` でも変わらない）。
        // 渡すのは 1 つだけにして、もう片方は取ってきた作者で絞る。
        let built = runs(&query("ほげ", "", "tatsu", ""), true);
        let author_run = &built[1];
        let authors = author_run
            .args
            .iter()
            .filter(|arg| arg.starts_with("--author="))
            .count();
        assert_eq!(authors, 1);
        assert!(has(&author_run.args, "--author=tatsu"));
        assert_eq!(author_run.author_contains.as_deref(), Some("ほげ"));

        // メッセージ側の回は git だけで足りる。
        assert_eq!(built[0].author_contains, None);
    }

    #[test]
    fn one_author_is_left_to_git() {
        let named = runs(&query("", "", "tatsu", ""), true);
        assert_eq!(named[0].author_contains, None);
        assert!(has(&named[0].args, "--author=tatsu"));

        let bare = runs(&query("ほげ", "", "", ""), true);
        assert_eq!(bare[1].author_contains, None);
        assert!(has(&bare[1].args, "--author=ほげ"));
    }

    #[test]
    fn code_rides_on_every_run() {
        // 載せ忘れると pickaxe が全コミットぶんの差分を取る（onyx で 5.9 秒 → 17.1 秒）。
        let built = args_of(&query("ほげ", "", "", "NEEDLE"));
        assert_eq!(built.len(), 2);
        for args in &built {
            assert!(has(args, "-SNEEDLE"));
        }
    }

    #[test]
    fn a_value_that_starts_with_a_dash_is_not_a_flag() {
        // `--grep` と値を別の引数に割ると、`--pretty` が git のフラグとして食われる。
        let built = args_of(&query("", "--pretty", "", "-S"));
        assert!(has(&built[0], "--grep=--pretty"));
        assert!(has(&built[0], "-S-S"));
    }

    #[test]
    fn the_starting_refs_never_include_all() {
        for args in args_of(&query("ほげ", "", "", "")) {
            assert!(has(&args, "--branches"));
            assert!(has(&args, "--remotes"));
            assert!(has(&args, "HEAD"));
            // タグ・stash・notes を起点にしない（CLAUDE.md §2 / DESIGN.md §4.2）。
            assert!(!has(&args, "--all"));
        }
    }

    #[test]
    fn an_unborn_head_is_not_passed() {
        // コミット 0 件のリポジトリに `HEAD` を渡すと git log 全体が失敗する。
        for run in runs(&query("ほげ", "", "", ""), false) {
            assert!(!has(&run.args, "HEAD"));
        }
    }

    #[test]
    fn blank_values_are_not_asked() {
        // 空白だけの指定は「打っていない」と同じ。
        let built = args_of(&query("", "   ", "tatsu", ""));
        assert_eq!(built.len(), 1);
        assert!(!built[0].iter().any(|arg| arg.starts_with("--grep=")));
        assert!(!has(&built[0], "--all-match"));
    }

    #[test]
    fn an_empty_query_is_empty() {
        assert!(query("", "", "", "").is_empty());
        assert!(query("", "   ", "", "").is_empty());
        assert!(!query("", "", "", "x").is_empty());
    }

    #[test]
    fn parses_the_sha_and_the_author() {
        let record = |sha: &str, name: &str, mail: &str| {
            format!("{sha}\u{1f}{name}\u{1f}{mail}\0")
        };
        let stdout = format!(
            "{}{}",
            record(&"a".repeat(40), "GitPeek Test", "test@example.invalid"),
            record(&"b".repeat(40), "Hanako Example", "hanako@example.invalid"),
        );
        let found = parse(&stdout);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].sha, "a".repeat(40));
        // `--author` が見ているのと同じ形にそろえる。
        assert_eq!(found[1].author, "Hanako Example <hanako@example.invalid>");
    }

    #[test]
    fn ignores_incomplete_records() {
        assert!(parse("").is_empty());
        assert!(parse("\0\0").is_empty());
        // 作者が欠けていても SHA が読めれば落とさない。
        assert_eq!(parse(&format!("{}\0", "c".repeat(40)))[0].sha, "c".repeat(40));
    }

    /// フロントが送る JSON をそのまま食えること（CLAUDE.md §8）。
    ///
    /// **食えなければコマンドは 1 度も走らない。** 組み立てだけを固定しても、
    /// 受け取りの形が違えば何も起きない（T-18 で踏んだ）。
    #[test]
    fn the_query_wire_format_matches_what_the_front_end_sends() {
        let parsed: CommitQuery = serde_json::from_str(
            r#"{"any":"ほげ","message":null,"author":null,"code":"NEEDLE"}"#,
        )
        .expect("フロントの JSON を食えること");
        assert_eq!(parsed.any.as_deref(), Some("ほげ"));
        assert_eq!(parsed.message, None);
        assert_eq!(parsed.code.as_deref(), Some("NEEDLE"));
    }

    /// 返す形がフロントの読む形であること（逆向き）。
    #[test]
    fn the_outcome_wire_format_is_what_the_front_end_reads() {
        let outcome = super::CommitSearchOutcome {
            shas: vec!["a".repeat(40)],
            elapsed_ms: 12,
        };
        let json = serde_json::to_value(&outcome).expect("JSON にできること");
        assert_eq!(json["shas"][0], "a".repeat(40));
        // スネークケースのまま返すとフロントが読めない。
        assert_eq!(json["elapsedMs"], 12);
    }
}
