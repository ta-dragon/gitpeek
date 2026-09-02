//! `git for-each-ref` の実行とパース、および ref 集合の指紋。
//!
//! ref はグラフの起点であり（docs/DESIGN.md §4.2）、同時にキャッシュの鍵でもある。
//! 「ref の集合が変わっていなければグラフも変わっていない」という前提で
//! [`fingerprint`] を使い、スナップショットの再取得を省く（§4.1）。

use std::collections::HashSet;
use std::fmt::Write as _;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::commandlog::LogSink;
use crate::git::exec;
use crate::model::{HeadInfo, RefEntry, RefKind};

/// フィールド区切り（Unit Separator）。ref 名には現れない。
const FIELD: char = '\u{1f}';

/// `for-each-ref` の書式。
///
/// **`git log` と書式言語が違う。** `for-each-ref` は `%x1f` を展開せず文字列
/// `%x1f` をそのまま出すので、16 進 2 桁の `%1f` を使うこと（git 2.43 で確認）。
///
/// - `%(*objectname)` — annotated tag が指すコミット。軽量タグでは空
/// - `%(symref)` — symbolic ref の指す先。`refs/remotes/origin/HEAD` だけが持つ
const FORMAT: &str = "--format=%(objectname)%1f%(refname)%1f%(objecttype)%1f%(*objectname)%1f%(upstream)%1f%(symref)";

/// ref 一覧の取得結果。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Refs {
    /// ブランチ・リモート追跡ブランチ・タグ。symbolic ref は含まない。
    pub entries: Vec<RefEntry>,
    /// `refs/remotes/*/HEAD` が指す ref 名。既定ブランチの第一候補。
    pub origin_head: Option<String>,
}

/// ローカルブランチ・リモート追跡ブランチ・タグを列挙する。
///
/// `refs/stash` と `refs/notes/` は最初から対象にしない（§4.2）。
pub fn load(log: &dyn LogSink, program: &str, path: &Path) -> Result<Refs, String> {
    let output = exec::run(
        log,
        program,
        Some(path),
        &[
            "for-each-ref",
            FORMAT,
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    if !output.ok() {
        return Err(output.failure("ref の一覧を取得できませんでした"));
    }

    Ok(parse(&String::from_utf8_lossy(&output.stdout)))
}

/// `for-each-ref` の出力を分解する。
///
/// ref 名は改行を含めないので行区切りで安全に割れる。
pub fn parse(stdout: &str) -> Refs {
    let mut refs = Refs::default();

    for line in stdout.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }

        let mut fields = line.splitn(6, FIELD);
        let (Some(object), Some(name), Some(object_type), Some(peeled), Some(upstream)) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            continue;
        };
        let symref = fields.next().unwrap_or_default();

        // symbolic ref（`origin/HEAD`）はブランチではない。一覧には入れず、
        // 既定ブランチの候補としてだけ覚えておく。
        if !symref.is_empty() {
            if name.starts_with("refs/remotes/") && name.ends_with("/HEAD") {
                refs.origin_head = Some(symref.to_string());
            }
            continue;
        }

        let Some((kind, short_name)) = classify(name) else {
            continue;
        };

        // annotated tag は tag オブジェクトを指すので、peel 後のコミットを採る。
        // 軽量タグは objecttype が commit で `%(*objectname)` は空。
        let target = if object_type == "tag" && !peeled.is_empty() {
            peeled
        } else {
            object
        };
        if target.is_empty() {
            continue;
        }

        refs.entries.push(RefEntry {
            name: name.to_string(),
            short_name: short_name.to_string(),
            kind,
            target: target.to_string(),
            upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
            // コミット集合が確定してから [`mark_out_of_graph`] で埋める。
            out_of_graph: false,
        });
    }

    refs
}

/// ref 名から種別と表示名を決める。想定外の名前空間は `None`。
fn classify(name: &str) -> Option<(RefKind, &str)> {
    if let Some(short) = name.strip_prefix("refs/heads/") {
        Some((RefKind::LocalBranch, short))
    } else if let Some(short) = name.strip_prefix("refs/remotes/") {
        Some((RefKind::RemoteBranch, short))
    } else if let Some(short) = name.strip_prefix("refs/tags/") {
        Some((RefKind::Tag, short))
    } else {
        None
    }
}

/// コミット集合に含まれない ref に印を付ける（§4.2）。
///
/// タグを起点 ref にしない結果、ブランチが消された古いリリースタグはここに落ちる。
/// ツリーには出すが、ジャンプは無効化する。
pub fn mark_out_of_graph(entries: &mut [RefEntry], commits: &HashSet<&str>) {
    for entry in entries {
        entry.out_of_graph = !commits.contains(entry.target.as_str());
    }
}

/// lane 0 を予約する幹の ref を決める（CLAUDE.md §3-1）。
///
/// `origin/HEAD` → `main` → `master` → HEAD のブランチ、の順。
/// どれも無ければ `None`（レーン計算側は最初のコミットを幹として扱う）。
pub fn default_branch(refs: &Refs, head: &HeadInfo) -> Option<String> {
    let known = |name: &str| refs.entries.iter().any(|entry| entry.name == name);

    refs.origin_head
        .as_deref()
        .filter(|name| known(name))
        .or(Some("refs/heads/main").filter(|name| known(name)))
        .or(Some("refs/heads/master").filter(|name| known(name)))
        .map(str::to_string)
        .or_else(|| {
            let branch = format!("refs/heads/{}", head.branch.as_deref()?);
            known(&branch).then_some(branch)
        })
}

/// ref 集合と HEAD の指紋。これが変わらない限りグラフは変わらない。
///
/// ref 名でソートしてから混ぜるので、`for-each-ref` の並びには依存しない。
pub fn fingerprint(entries: &[RefEntry], head: &HeadInfo) -> String {
    let mut pairs: Vec<(&str, &str)> = entries
        .iter()
        .map(|entry| (entry.name.as_str(), entry.target.as_str()))
        .collect();
    pairs.sort_unstable();

    let mut hasher = Sha256::new();
    for (name, target) in pairs {
        hasher.update(name.as_bytes());
        hasher.update([0x1f]);
        hasher.update(target.as_bytes());
        hasher.update([0x00]);
    }
    // detached HEAD の移動は ref を動かさないので、HEAD も混ぜる。
    hasher.update(head.sha.as_deref().unwrap_or("").as_bytes());
    hasher.update([0x1f]);
    hasher.update(head.branch.as_deref().unwrap_or("").as_bytes());

    let mut hex = String::with_capacity(64);
    for byte in hasher.finalize() {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::{default_branch, fingerprint, mark_out_of_graph, parse};
    use crate::model::{HeadInfo, RefKind};
    use std::collections::HashSet;

    fn line(fields: &[&str]) -> String {
        format!("{}\n", fields.join("\u{1f}"))
    }

    fn head(branch: Option<&str>, sha: Option<&str>) -> HeadInfo {
        HeadInfo {
            sha: sha.map(str::to_string),
            branch: branch.map(str::to_string),
            detached: branch.is_none() && sha.is_some(),
            unborn: sha.is_none(),
        }
    }

    #[test]
    fn classifies_branches_remotes_and_tags() {
        let stdout = [
            line(&["aaa", "refs/heads/main", "commit", "", "refs/remotes/origin/main", ""]),
            line(&["bbb", "refs/remotes/origin/main", "commit", "", "", ""]),
            line(&["ccc", "refs/tags/v1.0", "commit", "", "", ""]),
        ]
        .concat();

        let refs = parse(&stdout);
        assert_eq!(refs.entries.len(), 3);

        assert_eq!(refs.entries[0].kind, RefKind::LocalBranch);
        assert_eq!(refs.entries[0].short_name, "main");
        assert_eq!(refs.entries[0].upstream.as_deref(), Some("refs/remotes/origin/main"));

        assert_eq!(refs.entries[1].kind, RefKind::RemoteBranch);
        assert_eq!(refs.entries[1].short_name, "origin/main");
        // 上流の無い ref は None。空文字にしない。
        assert_eq!(refs.entries[1].upstream, None);

        assert_eq!(refs.entries[2].kind, RefKind::Tag);
        assert_eq!(refs.entries[2].short_name, "v1.0");
    }

    #[test]
    fn peels_annotated_tags() {
        let stdout = [
            // 軽量タグ: objectname がそのままコミット。
            line(&["c0ffee", "refs/tags/light", "commit", "", "", ""]),
            // 注釈付きタグ: objectname は tag オブジェクト、*objectname がコミット。
            line(&["8b599b8", "refs/tags/annotated", "tag", "68a3b1c", "", ""]),
        ]
        .concat();

        let refs = parse(&stdout);
        assert_eq!(refs.entries[0].target, "c0ffee");
        assert_eq!(refs.entries[1].target, "68a3b1c");
    }

    #[test]
    fn keeps_origin_head_out_of_the_list() {
        let stdout = [
            line(&["aaa", "refs/remotes/origin/HEAD", "commit", "", "", "refs/remotes/origin/main"]),
            line(&["aaa", "refs/remotes/origin/main", "commit", "", "", ""]),
        ]
        .concat();

        let refs = parse(&stdout);
        // symbolic ref をブランチとして数えると origin/main が二重に見える。
        assert_eq!(refs.entries.len(), 1);
        assert_eq!(refs.origin_head.as_deref(), Some("refs/remotes/origin/main"));
    }

    #[test]
    fn marks_refs_whose_target_is_not_in_the_graph() {
        let stdout = [
            line(&["aaa", "refs/heads/main", "commit", "", "", ""]),
            line(&["zzz", "refs/tags/old-release", "commit", "", "", ""]),
        ]
        .concat();

        let mut refs = parse(&stdout);
        let commits: HashSet<&str> = ["aaa"].into_iter().collect();
        mark_out_of_graph(&mut refs.entries, &commits);

        assert!(!refs.entries[0].out_of_graph);
        // ブランチが消された古いタグはグラフ外。
        assert!(refs.entries[1].out_of_graph);
    }

    #[test]
    fn ignores_unknown_namespaces_and_short_lines() {
        let stdout = [
            line(&["aaa", "refs/stash", "commit", "", "", ""]),
            line(&["bbb", "refs/notes/commits", "commit", "", "", ""]),
            line(&["ccc"]),
            line(&["aaa", "refs/heads/main", "commit", "", "", ""]),
        ]
        .concat();

        let refs = parse(&stdout);
        assert_eq!(refs.entries.len(), 1);
        assert_eq!(refs.entries[0].name, "refs/heads/main");
    }

    #[test]
    fn prefers_origin_head_then_main_then_master() {
        let stdout = [
            line(&["aaa", "refs/heads/master", "commit", "", "", ""]),
            line(&["bbb", "refs/heads/main", "commit", "", "", ""]),
            line(&["ccc", "refs/remotes/origin/develop", "commit", "", "", ""]),
        ]
        .concat();
        let mut refs = parse(&stdout);

        // origin/HEAD があればそれが幹。
        refs.origin_head = Some("refs/remotes/origin/develop".to_string());
        assert_eq!(
            default_branch(&refs, &head(Some("main"), Some("bbb"))).as_deref(),
            Some("refs/remotes/origin/develop")
        );

        // 無ければ main、main も無ければ master。
        refs.origin_head = None;
        assert_eq!(
            default_branch(&refs, &head(Some("master"), Some("aaa"))).as_deref(),
            Some("refs/heads/main")
        );
        refs.entries.retain(|entry| entry.name != "refs/heads/main");
        assert_eq!(
            default_branch(&refs, &head(Some("master"), Some("aaa"))).as_deref(),
            Some("refs/heads/master")
        );
    }

    #[test]
    fn falls_back_to_head_and_then_to_nothing() {
        let refs = parse(&line(&["aaa", "refs/heads/work", "commit", "", "", ""]));
        assert_eq!(
            default_branch(&refs, &head(Some("work"), Some("aaa"))).as_deref(),
            Some("refs/heads/work")
        );
        // detached HEAD で main/master も無ければ幹を決められない。
        assert_eq!(default_branch(&refs, &head(None, Some("aaa"))), None);
        // 指す先が origin/HEAD にあっても、その ref 自体が無ければ採らない。
        let mut orphan = refs.clone();
        orphan.origin_head = Some("refs/remotes/origin/gone".to_string());
        assert_eq!(
            default_branch(&orphan, &head(None, Some("aaa"))),
            None
        );
    }

    #[test]
    fn fingerprint_changes_with_refs_and_head_but_not_with_order() {
        let a = parse(
            &[
                line(&["aaa", "refs/heads/main", "commit", "", "", ""]),
                line(&["bbb", "refs/heads/topic", "commit", "", "", ""]),
            ]
            .concat(),
        );
        let reordered = parse(
            &[
                line(&["bbb", "refs/heads/topic", "commit", "", "", ""]),
                line(&["aaa", "refs/heads/main", "commit", "", "", ""]),
            ]
            .concat(),
        );
        let moved = parse(
            &[
                line(&["ccc", "refs/heads/main", "commit", "", "", ""]),
                line(&["bbb", "refs/heads/topic", "commit", "", "", ""]),
            ]
            .concat(),
        );

        let on_main = head(Some("main"), Some("aaa"));
        let base = fingerprint(&a.entries, &on_main);

        // 列挙順は指紋に影響しない。
        assert_eq!(fingerprint(&reordered.entries, &on_main), base);
        // ブランチが進めば変わる。
        assert_ne!(fingerprint(&moved.entries, &on_main), base);
        // ref が同じでも HEAD が動けば変わる（detached での移動）。
        assert_ne!(fingerprint(&a.entries, &head(None, Some("bbb"))), base);
        // ref が減っても変わる。
        assert_ne!(fingerprint(&a.entries[..1], &on_main), base);
    }
}
