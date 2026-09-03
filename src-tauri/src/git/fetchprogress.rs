//! fetch / clone の進捗行のパース（docs/DESIGN.md §8.3, §8.4）。
//!
//! **git の進捗は stdout ではなく stderr に出る。** しかも `\r` で同じ行を上書きしていく
//! ので、`\n` だけで区切ると 1 行も確定しないまま最後にまとめて届く。バーが一度も
//! 動かないのはたいていこれ。
//!
//! **ラベルで判定してはいけない。** git は環境によって進捗そのものを翻訳する
//! （`Receiving objects` が「オブジェクトを受信中」になる）。ここでは `(済/全)` と `%`
//! だけを構造で取り、ラベルは読み取らずそのまま表示へ回す。

use serde::Serialize;

/// 1 回ぶんの進捗。
///
/// `total` は**分母がある段階だけ** `Some`。`Counting objects: 1234` のように
/// 総数が分からない段階があるので、割合を捏造せず `None` を通す
/// （フロントの `LoadProgress` は総数 `null` を不定表示として受ける）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchProgress {
    /// git が出した見出しをそのまま。翻訳されていてもそのまま出す。
    pub label: String,
    pub done: u64,
    pub total: Option<u64>,
}

/// stderr の断片を溜め、`\r` と `\n` の**両方**で行に切り出す。
///
/// 断片は UTF-8 の途中で切れうるので、**バイトのまま溜めて行単位で復号する**。
/// 区切り文字はどちらも ASCII なので、行の境界で多バイト文字が割れることはない。
#[derive(Debug, Default)]
pub struct LineSplitter {
    buffer: Vec<u8>,
}

impl LineSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// 断片を足し、確定した行を返す。空行は返さない（CRLF が空の断片を作るため）。
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(chunk);

        let mut lines = Vec::new();
        let mut start = 0;
        for (index, byte) in self.buffer.iter().enumerate() {
            if *byte != b'\r' && *byte != b'\n' {
                continue;
            }
            let line = &self.buffer[start..index];
            if !line.is_empty() {
                lines.push(String::from_utf8_lossy(line).into_owned());
            }
            start = index + 1;
        }
        self.buffer.drain(..start);
        lines
    }

    /// 最後まで読み終えたあとに残っている断片。改行で終わらない出力のため。
    pub fn flush(&mut self) -> Option<String> {
        if self.buffer.is_empty() {
            return None;
        }
        let line = String::from_utf8_lossy(&self.buffer).into_owned();
        self.buffer.clear();
        Some(line)
    }
}

/// 1 行を進捗として読む。**進捗でなければ `None`**（そのまま結果の本文へ回す）。
pub fn parse(line: &str) -> Option<FetchProgress> {
    let line = strip_remote(line.trim());

    // 「ラベル: 数値部分」。**後ろの `:` で切る** — `From https://…` のように
    // ラベル側に `:` を含む行があり、前から切ると数値部分を取り違える。
    let (label, rest) = line.rsplit_once(':')?;
    let label = label.trim();
    if label.is_empty() {
        return None;
    }

    // 分母のある段階。`(1.2 MiB | 3.4 MiB/s)` のような `/` を拾わないよう、
    // **括弧の中だけ**を見る。`(delta 45)` のように `/` の無い括弧は飛ばす。
    if let Some((done, total)) = fraction(rest) {
        return Some(FetchProgress {
            label: label.to_string(),
            done,
            total: Some(total),
        });
    }

    // 分母が無く割合だけの段階。分母 100 として扱う。
    if let Some(percent) = percentage(rest) {
        return Some(FetchProgress {
            label: label.to_string(),
            done: percent,
            total: Some(100),
        });
    }

    // `Counting objects: 1234` のように件数だけの段階。総数は分からない。
    let done = leading_number(rest)?;
    Some(FetchProgress {
        label: label.to_string(),
        done,
        total: None,
    })
}

/// `remote: ` を剥がす。リモート側の進捗が中継されるときに付く（重なることがある）。
fn strip_remote(line: &str) -> &str {
    let mut line = line;
    while let Some(rest) = line.strip_prefix("remote:") {
        line = rest.trim_start();
    }
    line
}

/// 括弧の中の `済/全` を探す。最初に見つかったものを使う。
fn fraction(text: &str) -> Option<(u64, u64)> {
    let mut rest = text;
    while let Some(open) = rest.find('(') {
        let after = &rest[open + 1..];
        // 閉じ括弧が無いのは行が途中で切れているとき。**先を探しに行かない**
        // （残りに `(` が無い以上、無限に回る道は無いが、意味の無い探索になる）。
        let close = after.find(')')?;
        let inside = &after[..close];
        if let Some((left, right)) = inside.split_once('/') {
            if let (Ok(done), Ok(total)) = (left.trim().parse(), right.trim().parse()) {
                return Some((done, total));
            }
        }
        rest = &after[close + 1..];
    }
    None
}

/// `42%` の 42。`%` の直前の数字を読む。
fn percentage(text: &str) -> Option<u64> {
    let at = text.find('%')?;
    let digits: String = text[..at]
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.chars().rev().collect::<String>().parse().ok()
}

/// 先頭の数字。`1234, done.` のように後ろに文が続くことがある。
///
/// **数字のあとに文の区切り以外が続くものは数えない。** ポート番号付きの URL
/// （`From https://example.com:8080/foo`）を「8080 件」と読んでしまうため。
fn leading_number(text: &str) -> Option<u64> {
    let text = text.trim_start();
    let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    match text[digits.len()..].chars().next() {
        None | Some(',') | Some('.') | Some(' ') => digits.parse().ok(),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{parse, FetchProgress, LineSplitter};

    fn progress(label: &str, done: u64, total: Option<u64>) -> Option<FetchProgress> {
        Some(FetchProgress {
            label: label.to_string(),
            done,
            total,
        })
    }

    /// **`\r` で切れること。** これを落とすとバーが一度も動かない。
    #[test]
    fn splits_on_carriage_returns() {
        let mut splitter = LineSplitter::new();
        let lines = splitter.push(b"Receiving objects:  1% (1/100)\rReceiving objects:  2% (2/100)\r");
        assert_eq!(
            lines,
            vec![
                "Receiving objects:  1% (1/100)".to_string(),
                "Receiving objects:  2% (2/100)".to_string(),
            ]
        );
    }

    /// CRLF は空の断片を作る。空行を返すと本文が改行だらけになる。
    #[test]
    fn drops_empty_segments_from_crlf() {
        let mut splitter = LineSplitter::new();
        assert_eq!(splitter.push(b"From origin\r\n"), vec!["From origin".to_string()]);
        assert_eq!(splitter.flush(), None);
    }

    /// 断片は UTF-8 の途中で切れる。バイトで溜めていないと文字が壊れる。
    #[test]
    fn joins_multibyte_characters_split_across_chunks() {
        let text = "オブジェクトを受信中:  50% (5/10)\n".as_bytes();
        let (head, tail) = text.split_at(4); // 「オ」の途中で切る
        let mut splitter = LineSplitter::new();
        assert!(splitter.push(head).is_empty());
        assert_eq!(
            splitter.push(tail),
            vec!["オブジェクトを受信中:  50% (5/10)".to_string()]
        );
    }

    #[test]
    fn keeps_an_unterminated_tail_until_flush() {
        let mut splitter = LineSplitter::new();
        assert!(splitter.push(b"Counting objects: 12").is_empty());
        assert_eq!(splitter.flush(), Some("Counting objects: 12".to_string()));
        assert_eq!(splitter.flush(), None);
    }

    #[test]
    fn reads_a_fraction() {
        assert_eq!(
            parse("Receiving objects:  42% (123/456), 1.20 MiB | 3.40 MiB/s"),
            progress("Receiving objects", 123, Some(456)),
        );
    }

    /// `remote: ` が前に付く（中継された進捗）。重なることもある。
    #[test]
    fn strips_the_remote_prefix() {
        assert_eq!(
            parse("remote: Compressing objects:  50% (5/10)"),
            progress("Compressing objects", 5, Some(10)),
        );
        assert_eq!(
            parse("remote: remote: Counting objects: 100% (7/7)"),
            progress("Counting objects", 7, Some(7)),
        );
    }

    /// **ラベルで判定しないこと。** git は進捗を翻訳する。
    #[test]
    fn reads_a_translated_label() {
        assert_eq!(
            parse("オブジェクトを受信中:  42% (123/456)"),
            progress("オブジェクトを受信中", 123, Some(456)),
        );
    }

    /// 分母の無い段階。**割合を捏造しない。**
    #[test]
    fn reads_a_bare_count() {
        assert_eq!(
            parse("Counting objects: 1234, done."),
            progress("Counting objects", 1234, None),
        );
    }

    #[test]
    fn reads_a_bare_percentage() {
        assert_eq!(parse("Resolving deltas:  30%"), progress("Resolving deltas", 30, Some(100)));
    }

    /// `MiB/s` の `/` を分数と読まないこと（括弧の中しか見ない）。
    #[test]
    fn ignores_slashes_outside_parentheses() {
        assert_eq!(
            parse("Receiving objects: 100% (10/10), 5.00 KiB | 2.50 MiB/s, done."),
            progress("Receiving objects", 10, Some(10)),
        );
    }

    /// `/` の無い括弧は飛ばして先を見る。
    #[test]
    fn skips_parentheses_without_a_slash() {
        assert_eq!(
            parse("remote: Counting objects: (delta 45) 60% (6/10)"),
            progress("Counting objects", 6, Some(10)),
        );
    }

    /// 進捗でない行は `None`。結果の本文としてそのまま残る。
    #[test]
    fn rejects_lines_that_are_not_progress() {
        assert_eq!(parse("From https://example.com/foo/bar"), None);
        assert_eq!(
            parse("From https://example.com:8080/foo/bar"),
            None,
            "ポート番号を件数と読まないこと",
        );
        assert_eq!(parse(" * [new branch]      main       -> origin/main"), None);
        assert_eq!(
            parse("fatal: could not read Username for 'https://example.com': terminal prompts disabled"),
            None,
        );
        assert_eq!(parse("remote: Total 123 (delta 45), reused 60 (delta 20)"), None);
        assert_eq!(parse(""), None);
        assert_eq!(parse("   "), None);
        assert_eq!(parse(":"), None);
        assert_eq!(parse(": 50% (1/2)"), None, "ラベルの無い行は進捗として扱わない");
    }

    /// 閉じ括弧の無い壊れた行で固まらないこと。
    #[test]
    fn survives_a_broken_line() {
        assert_eq!(parse("Receiving objects: (12"), None);
        assert_eq!(parse("Receiving objects: (a/b)"), None);
    }
}
