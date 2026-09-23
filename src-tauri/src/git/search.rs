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
//!
//! **ファイルを変えたコミット**（T-40。§6.7）は `path` で探す。改名は `--follow` に任せず
//! [`follow_names`] が辿り、見つけた名前を全部 pathspec にして同じ実行に載せる。

use std::collections::HashSet;
use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::commandlog::LogSink;
use crate::git::exec::{self, Cancel};

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
    /// このファイルを変えたコミット（T-40）。リポジトリの根からのパス。
    /// **改名は [`follow_names`] が辿る**ので、ここには今の名前を 1 つだけ入れる。
    #[serde(default)]
    pub path: Option<String>,
}

impl CommitQuery {
    /// 探すことばが 1 つも無いか。**空白だけの値は無いものとして扱う。**
    pub fn is_empty(&self) -> bool {
        [&self.any, &self.message, &self.author, &self.code, &self.path]
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
    /// 中止した（T-36）。**`shas` はそこまでに見つかったぶんで、全部ではない。**
    pub cancelled: bool,
    /// ファイルを探したとき、**改名を辿って含めた名前**（T-40）。先頭が打った名前で、
    /// 古い名前が後に続く。`path` が無ければ空。**黙って広げない**ために画面へ出す。
    pub paths: Vec<String>,
    /// 名前が [`MAX_NAMES`] に届いて、それより古い改名を辿るのをやめた。
    pub truncated: bool,
}

/// 改名を辿る名前の上限（T-40）。**これより古い改名は辿らず、そう画面に出す。**
pub const MAX_NAMES: usize = 20;

/// `--format=%x1e%H` の、1 件の始まり（Record Separator）。
const RECORD: char = 0x1e_u8 as char;

/// 改名を辿った結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Followed {
    /// 先頭が打った名前。古い名前が見つけた順に続く。
    pub names: Vec<String>,
    /// [`MAX_NAMES`] で止めた。
    pub truncated: bool,
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
///
/// **`names` が空でなければ、そのファイルを変えたコミットに絞る**（T-40）。
/// `--full-history --simplify-merges` を付ける — 既定の簡略化は、マージが片方の親と同じに
/// なると**もう片方の親の側を辿らず、ファイルを実際に変えたコミットを黙って落とす**
/// （onyx の `backend/onyx/main.py` で 13 件。`--full-history` だけだとマージが 128 件並ぶ。§6.7）。
pub fn runs(query: &CommitQuery, include_head: bool, names: &[String]) -> Vec<Run> {
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

            let mut args: Vec<String> = Vec::new();
            if !names.is_empty() {
                // パスを glob / magic として読ませない（`[x].txt` が `x.txt` に当たる）。
                // **git 全体のオプションなので `log` の前。**
                args.push("--literal-pathspecs".into());
            }
            args.extend(["log".into(), "--branches".into(), "--remotes".into()]);
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
            if !names.is_empty() {
                args.extend(["--full-history".into(), "--simplify-merges".into(), "--".into()]);
                args.extend(names.iter().cloned());
            }
            Run {
                args,
                author_contains,
            }
        })
        .collect()
}

/// **ファイルの改名を辿り、昔の名前を集める**（T-40。§6.7）。
///
/// **`git log --follow` を使わない。** `--follow` は「改名を見つけたら、以後はその名前だけを
/// 追う」を履歴全体で 1 本やるので、**並行するブランチで古い名前のまま直したコミットを落とす**
/// （`--topo-order` だと全部落とす。§17.1）。ここでは名前を集めるだけにして、コミットは
/// 全部の名前を pathspec にした 1 回の `log` で取る（[`runs`]）。
///
/// 1. 名前のどれかを**足した**コミットを探す（`--diff-filter=A`。`--no-renames` で、改名も
///    足したものとして出させる）
/// 2. そのコミットを `diff-tree -M` で見て、足した名前が**改名先**なら改名元を名前に加える
/// 3. 名前が増えなくなるまで繰り返す。[`MAX_NAMES`] に届いたら止める
///
/// ルートコミットとマージは `diff-tree` が何も出さないので、改名元は探さない。
pub fn follow_names(
    log: &dyn LogSink,
    program: &str,
    path: &Path,
    file: &str,
    include_head: bool,
) -> Result<Followed, String> {
    let mut names = vec![file.to_string()];
    let mut looked: HashSet<(String, String)> = HashSet::new();

    loop {
        let mut args: Vec<String> = vec![
            "--literal-pathspecs".into(),
            "log".into(),
            "--branches".into(),
            "--remotes".into(),
        ];
        if include_head {
            args.push("HEAD".into());
        }
        args.extend(
            [
                // 簡略化で、枝の側の「足した」コミットを落とさない。
                "--full-history",
                "--no-renames",
                "--diff-filter=A",
                "--name-status",
                "-z",
                "--format=%x1e%H",
                "--",
            ]
            .map(String::from),
        );
        args.extend(names.iter().cloned());
        let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = exec::run(log, program, Some(path), &borrowed)?;
        if !output.ok() {
            return Err(output.failure("ファイルの改名を辿れませんでした"));
        }

        let mut grew = false;
        for (sha, added) in parse_added(&String::from_utf8_lossy(&output.stdout)) {
            if !names.contains(&added) || !looked.insert((sha.clone(), added.clone())) {
                continue;
            }
            let Some(source) = renamed_from(log, program, path, &sha, &added)? else {
                continue;
            };
            if names.contains(&source) {
                continue;
            }
            if names.len() >= MAX_NAMES {
                return Ok(Followed {
                    names,
                    truncated: true,
                });
            }
            names.push(source);
            grew = true;
        }
        if !grew {
            return Ok(Followed {
                names,
                truncated: false,
            });
        }
    }
}

/// `--name-status -z --format=%x1e%H` の出力から「どのコミットがどのパスを足したか」を取る。
///
/// 1 件は [`RECORD`] で始まり、`SHA NUL 改行` のあとに `状態 NUL パス NUL` が続く。
/// `--no-renames` なので、パスはいつも 1 つ。
pub fn parse_added(stdout: &str) -> Vec<(String, String)> {
    let mut added = Vec::new();
    for record in stdout.split(RECORD) {
        let mut fields = record.split('\0');
        let sha = fields.next().unwrap_or_default().trim();
        if sha.is_empty() {
            continue;
        }
        let rest: Vec<&str> = fields
            .map(|field| field.trim_start_matches('\n'))
            .filter(|field| !field.is_empty())
            .collect();
        for pair in rest.chunks(2) {
            if let [status, file] = pair {
                if status.starts_with('A') {
                    added.push((sha.to_string(), (*file).to_string()));
                }
            }
        }
    }
    added
}

/// `sha` で足された `added` が改名先なら、改名元を返す。
fn renamed_from(
    log: &dyn LogSink,
    program: &str,
    path: &Path,
    sha: &str,
    added: &str,
) -> Result<Option<String>, String> {
    let output = exec::run(
        log,
        program,
        Some(path),
        &["diff-tree", "-M", "-r", "--no-commit-id", "--name-status", "-z", sha],
    )?;
    if !output.ok() {
        return Err(output.failure("ファイルの改名を辿れませんでした"));
    }
    Ok(parse_renames(&String::from_utf8_lossy(&output.stdout))
        .into_iter()
        .find(|(_, to)| to == added)
        .map(|(from, _)| from))
}

/// `diff-tree --name-status -z` の出力から改名（元, 先）を取る。
///
/// **リネームとコピーだけパスを 2 つ食う**（CLAUDE.md §2）。数え違えると以降が全部ずれる。
pub fn parse_renames(stdout: &str) -> Vec<(String, String)> {
    let mut renames = Vec::new();
    let mut fields = stdout.split('\0').filter(|field| !field.is_empty());
    while let Some(status) = fields.next() {
        let status = status.trim_start_matches('\n');
        if status.starts_with('R') || status.starts_with('C') {
            let (Some(from), Some(to)) = (fields.next(), fields.next()) else {
                break;
            };
            if status.starts_with('R') {
                renames.push((from.to_string(), to.to_string()));
            }
        } else {
            fields.next();
        }
    }
    renames
}

/// 当たったコミット 1 件ぶん。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub sha: String,
    /// `名前 <メール>`。git の `--author` が見ているのと同じ形にそろえてある。
    pub author: String,
}

/// `-z --format=%H%x1f%an%x1f%ae` の出力を分解する。**壊れたレコードは飛ばす。**
///
/// **NUL で閉じていない最後のレコードは読まない。** 中止すると出力が途中で切れ、
/// SHA の前半だけが残ることがある（それを当たりとして返すと、どの行にも当たらない）。
pub fn parse(stdout: &str) -> Vec<Found> {
    let complete = match stdout.rfind('\0') {
        Some(end) => &stdout[..end],
        None => "",
    };
    complete
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
///
/// **中止は失敗ではない**（T-36）。落とされた git は非ゼロで終わるので、成否より先に
/// 旗を見る。中止したら**そこまでに見つかったぶんを返し**、残りの実行には進まない。
pub fn search(
    log: &dyn LogSink,
    program: &str,
    path: &Path,
    query: &CommitQuery,
    include_head: bool,
    cancel: &Cancel,
) -> Result<CommitSearchOutcome, String> {
    if query.is_empty() {
        return Err("探すことばがありません".to_string());
    }

    let started = Instant::now();
    let mut shas: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let file = query.path.as_deref().map(str::trim).unwrap_or("");
    let followed = if file.is_empty() {
        Followed {
            names: Vec::new(),
            truncated: false,
        }
    } else {
        follow_names(log, program, path, file, include_head)?
    };

    let mut cancelled = false;
    for run in runs(query, include_head, &followed.names) {
        let borrowed: Vec<&str> = run.args.iter().map(String::as_str).collect();
        let output = exec::run_streaming(
            log,
            program,
            Some(path),
            &borrowed,
            Some(cancel),
            &mut |_chunk| {},
        )?;
        cancelled = cancel.is_cancelled();
        if !cancelled && !output.ok() {
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
        if cancelled {
            break;
        }
    }

    Ok(CommitSearchOutcome {
        shas,
        elapsed_ms: started.elapsed().as_millis() as u64,
        cancelled,
        paths: followed.names,
        truncated: followed.truncated,
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
            path: None,
        }
    }

    fn args_of(query: &CommitQuery) -> Vec<Vec<String>> {
        runs(query, true, &[]).into_iter().map(|run| run.args).collect()
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
        let built = runs(&query("ほげ", "", "tatsu", ""), true, &[]);
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
        let named = runs(&query("", "", "tatsu", ""), true, &[]);
        assert_eq!(named[0].author_contains, None);
        assert!(has(&named[0].args, "--author=tatsu"));

        let bare = runs(&query("ほげ", "", "", ""), true, &[]);
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
        for run in runs(&query("ほげ", "", "", ""), false, &[]) {
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
    fn a_record_cut_off_by_cancelling_is_not_read() {
        // 中止すると出力が途中で切れる。SHA の前半を当たりとして返してはいけない。
        let stdout = format!("{}\u{1f}N\u{1f}m\0{}", "a".repeat(40), "b".repeat(17));
        let found = parse(&stdout);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].sha, "a".repeat(40));
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
            cancelled: true,
            paths: vec!["new.txt".into(), "old.txt".into()],
            truncated: false,
        };
        let json = serde_json::to_value(&outcome).expect("JSON にできること");
        assert_eq!(json["shas"][0], "a".repeat(40));
        // スネークケースのまま返すとフロントが読めない。
        assert_eq!(json["elapsedMs"], 12);
        assert_eq!(json["cancelled"], true);
        assert_eq!(json["paths"][1], "old.txt");
        assert_eq!(json["truncated"], false);
    }

    /// `path` を含む JSON を食えること（T-40）。**古いフロントが `path` を送らなくても食える。**
    #[test]
    fn the_query_wire_format_carries_the_path() {
        let parsed: CommitQuery = serde_json::from_str(
            r#"{"any":null,"message":null,"author":"tatsu","code":null,"path":"src/日本語 ファイル.ts"}"#,
        )
        .expect("フロントの JSON を食えること");
        assert_eq!(parsed.path.as_deref(), Some("src/日本語 ファイル.ts"));

        let without: CommitQuery =
            serde_json::from_str(r#"{"any":"x","message":null,"author":null,"code":null}"#)
                .expect("path が無くても食えること");
        assert_eq!(without.path, None);
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn a_path_alone_is_a_query() {
        let only_path = CommitQuery {
            path: Some("a.txt".into()),
            ..CommitQuery::default()
        };
        assert!(!only_path.is_empty());
        let blank = CommitQuery {
            path: Some("  ".into()),
            ..CommitQuery::default()
        };
        assert!(blank.is_empty());
    }

    #[test]
    fn the_names_go_after_the_separator_and_are_read_literally() {
        let built = runs(&query("", "", "tatsu", ""), true, &names(&["new.txt", "old.txt"]));
        assert_eq!(built.len(), 1);
        let args = &built[0].args;
        // `--literal-pathspecs` は git 全体のオプション。`log` より後ろに置くと git が断る。
        assert_eq!(args[0], "--literal-pathspecs");
        assert_eq!(args[1], "log");
        // 名前は `--` の後ろ。`-` で始まるパスがフラグとして食われない。
        let separator = args.iter().position(|arg| arg == "--").expect("-- があること");
        assert_eq!(&args[separator + 1..], ["new.txt", "old.txt"]);
        // 既定の簡略化はファイルを変えたコミットを落とす（§6.7）。
        assert!(has(args, "--full-history"));
        assert!(has(args, "--simplify-merges"));
        assert!(has(args, "--author=tatsu"));
    }

    #[test]
    fn every_run_is_narrowed_to_the_file() {
        // 素のことばは 2 回に割れる。どちらにも pathspec を載せないと、片方が全履歴から当たる。
        let built = args_of_with(&query("ほげ", "", "", ""), &names(&["a.txt"]));
        assert_eq!(built.len(), 2);
        for args in &built {
            assert_eq!(args.last().map(String::as_str), Some("a.txt"));
        }
    }

    #[test]
    fn without_a_path_nothing_about_files_is_added() {
        for args in args_of(&query("ほげ", "", "", "")) {
            assert!(!has(&args, "--literal-pathspecs"));
            assert!(!has(&args, "--full-history"));
            assert!(!has(&args, "--"));
        }
    }

    fn args_of_with(query: &CommitQuery, list: &[String]) -> Vec<Vec<String>> {
        runs(query, true, list).into_iter().map(|run| run.args).collect()
    }

    #[test]
    fn reads_which_commit_added_which_path() {
        let record = super::RECORD;
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let stdout = format!("{record}{a}\0\nA\0new.txt\0{record}{b}\0\nA\0old.txt\0A\0日本語 ファイル.txt\0");
        let added = super::parse_added(&stdout);
        assert_eq!(
            added,
            [
                (a.clone(), "new.txt".to_string()),
                (b.clone(), "old.txt".to_string()),
                (b, "日本語 ファイル.txt".to_string()),
            ]
        );
        assert!(super::parse_added("").is_empty());
    }

    #[test]
    fn reads_renames_and_steps_over_copies() {
        // **コピーもパスを 2 つ食う。** 1 つと数えると、次の状態をパスとして読む。
        let stdout = "M\0keep.txt\0C075\0base.txt\0copy.txt\0R100\0old.txt\0new.txt\0A\0fresh.txt\0";
        assert_eq!(
            super::parse_renames(stdout),
            [("old.txt".to_string(), "new.txt".to_string())]
        );
        assert!(super::parse_renames("").is_empty());
    }
}
