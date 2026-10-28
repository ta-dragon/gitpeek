//! stash の一覧（T-42。docs/DESIGN.md §7.5.1）。
//!
//! **見るだけ。** 作成・適用・削除の経路は無い（CLAUDE.md §1）。git に足すのは読むだけの
//! `stash list` 1 つで、中身は `git log -g refs/stash` なので `log` の書式がそのまま効く。
//!
//! **グラフには混ぜない。** stash は起点 ref ではない（CLAUDE.md §2 — `--all` を使わない理由と同じ）。
//! スナップショットにも入れない — 指紋（`refs::fingerprint`）が `refs/stash` を見ないので、
//! 混ぜるとキャッシュが stash の増減を見落とす。

use std::path::Path;

use serde::Serialize;

use crate::commandlog::LogSink;
use crate::git::exec;

/// フィールド区切り（Unit Separator）。`git/log.rs` と同じ。
const FIELD: char = '\u{1f}';

/// `stash list` の書式。**メッセージ（`%gs`）を最後に置く** — 区切り文字を含んでいても
/// 末尾フィールドとして丸ごと残る（`git/log.rs` と同じ理由）。
const FORMAT: &str = "--format=%H%x1f%P%x1f%gd%x1f%ct%x1f%gs";

/// stash 1 つ。
///
/// stash は親を 2 つか 3 つ持つマージコミット。第 1 親が**退避したときの HEAD**、第 2 親が
/// index の状態、第 3 親は `-u` で退避したときだけあり、**未追跡のファイルだけを持つルートコミット**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// stash そのもの（マージコミット）の SHA。
    pub sha: String,
    /// 第 1 親 ＝ 退避したときの HEAD（「元のコミット」）。
    pub base: String,
    /// 第 3 親 ＝ 未追跡のファイル。`-u` で退避していなければ None。
    pub untracked: Option<String>,
    /// `stash@{0}`。**stash を足すたびにずれる**ので、選択の記録には使わない。
    pub label: String,
    /// 退避した時刻（Unix 秒。`W` のコミット時刻）。
    pub time: i64,
    /// `On main: …` / `WIP on main: …`。分けるのはフロントの純関数（`lib/stash.ts`）。
    pub message: String,
}

/// 一覧を新しい順（`stash@{0}` から）に読む。**stash が無ければ空**（git は何も出さずに終わる）。
pub fn list(log: &dyn LogSink, program: &str, path: &Path) -> Result<Vec<StashEntry>, String> {
    // `-z` はレコード区切りを NUL にする。改行を含むメッセージでも行が割れない。
    let output = exec::run(log, program, Some(path), &["stash", "list", "-z", FORMAT])?;
    if !output.ok() {
        return Err(output.failure("stash の一覧を読めませんでした"));
    }
    // メッセージの文字コードは `git/log.rs` と同じ扱い（git が UTF-8 へ寄せる。化けたら置換文字のまま）。
    Ok(parse(&String::from_utf8_lossy(&output.stdout)))
}

/// `-z` 付き `stash list` の出力を分解する。壊れたレコードは黙って飛ばす。
pub fn parse(stdout: &str) -> Vec<StashEntry> {
    stdout.split('\0').filter_map(parse_record).collect()
}

fn parse_record(record: &str) -> Option<StashEntry> {
    let record = record.trim_matches('\n');
    if record.is_empty() {
        return None;
    }

    let mut fields = record.splitn(5, FIELD);
    let sha = fields.next()?;
    let parents: Vec<&str> = fields.next()?.split_whitespace().collect();
    let label = fields.next()?;
    let time = fields.next()?;
    let message = fields.next()?;

    // 親の無い stash は作れない。**第 1 親が無ければ「元のコミット」が言えない**ので落とす。
    let base = parents.first()?;
    if sha.is_empty() {
        return None;
    }

    Some(StashEntry {
        sha: sha.to_string(),
        base: base.to_string(),
        untracked: parents.get(2).map(|sha| sha.to_string()),
        label: label.to_string(),
        time: time.trim().parse().unwrap_or_default(),
        message: message.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{parse, StashEntry};

    /// 実際の `git stash list -z --format=...` の出力を 1 件ぶん組み立てる。
    fn record(sha: &str, parents: &str, label: &str, time: &str, message: &str) -> String {
        format!("{sha}\u{1f}{parents}\u{1f}{label}\u{1f}{time}\u{1f}{message}\0")
    }

    #[test]
    fn parses_a_stash_with_two_parents() {
        let out = record("w1", "base1 index1", "stash@{0}", "1793196226", "On main: 作業: 1 つ目");

        assert_eq!(
            parse(&out),
            vec![StashEntry {
                sha: "w1".into(),
                base: "base1".into(),
                untracked: None,
                label: "stash@{0}".into(),
                time: 1_793_196_226,
                message: "On main: 作業: 1 つ目".into(),
            }]
        );
    }

    #[test]
    fn the_third_parent_is_the_untracked_files() {
        let out = record("w2", "base index untracked", "stash@{1}", "1", "On main: 未追跡あり");

        let entries = parse(&out);
        assert_eq!(entries[0].base, "base");
        assert_eq!(entries[0].untracked.as_deref(), Some("untracked"));
    }

    #[test]
    fn keeps_the_order_git_gave() {
        let out = [
            record("a", "p q", "stash@{0}", "3", "WIP on feature: b57df2e 枝"),
            record("b", "p q", "stash@{1}", "2", "On main: 2"),
            record("c", "p q", "stash@{2}", "1", "On main: 1"),
        ]
        .concat();

        let labels: Vec<_> = parse(&out).into_iter().map(|entry| entry.label).collect();
        assert_eq!(labels, ["stash@{0}", "stash@{1}", "stash@{2}"]);
    }

    #[test]
    fn a_message_with_the_field_separator_stays_whole() {
        // メッセージを最後に置いてあるので、区切り文字が入っていても末尾へまとめて残る。
        let out = record("w", "p q", "stash@{0}", "1", "On main: a\u{1f}b");

        assert_eq!(parse(&out)[0].message, "On main: a\u{1f}b");
    }

    #[test]
    fn empty_output_is_no_stash() {
        // stash が無いと git は何も出さずに 0 で終わる。
        assert!(parse("").is_empty());
    }

    #[test]
    fn a_record_without_parents_is_dropped() {
        // 「元のコミット」が言えないものを並べない。
        let out = record("w", "", "stash@{0}", "1", "On main: x");

        assert!(parse(&out).is_empty());
    }
}
