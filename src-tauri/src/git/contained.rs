//! ブランチが相手に取り込まれているか（T-37。docs/DESIGN.md §7.6）。
//!
//! **squash マージは新しいコミットを作る**ので、元のブランチのコミットは相手の祖先にならず、
//! グラフの上では「マージされていない」ように見える。ここでは**中身**で判断する。
//!
//! - **③ `git merge-tree`**: 仮にマージして、結果が相手と同じ中身なら「入っている」。
//!   **書き込みはリポジトリの外の一時フォルダへ逸らす**（[`super::scratch`]。CLAUDE.md §1 の 4 件目）
//! - **② 差分の突き合わせ**: ブランチの差分と同じ変更を持つコミットが相手にあれば、それが squash
//!
//! ③で「入っているか」、②で「どこで入ったか」を見る。**片方が外れる場面をもう片方が拾う** —
//! ブランチに後から足した場合は③の二分探索が、相手で同じ行をさらに書き換えた場合は②が当たる。

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::path::Path;
use std::time::Instant;

use serde::Serialize;

use crate::commandlog::LogSink;
use crate::git::exec;
use crate::git::scratch::ScratchDir;
use crate::graph::reach::CommitIndex;
use crate::model::{CommitMeta, RefKind, RepositorySnapshot};

/// ②で差分まで比べる相手の上限。**新しいほうから**この数だけ見る。
///
/// 触ったファイルの組で絞った後なので、ふつうは 0〜2 件。`CHANGELOG.md` だけを触る
/// ブランチのように、同じ組のコミットが相手に何百もある場合の歯止め。
const MAX_CANDIDATES: usize = 100;

/// 判定の種類。**文言は持たない**（画面が種類から引く）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Containment {
    /// ブランチの先端が相手の祖先。普通にマージ済み（git を呼ばずに決まる）。
    Ancestor,
    /// 中身は全部入っている。squash したコミットが分かれば添える。
    Contained { squash: Option<String> },
    /// 分岐点から数えて `upto` 個目までは入っている（全部で `total` 個）。
    Partial {
        upto: u32,
        total: u32,
        squash: Option<String>,
    },
    /// squash されたが、その後相手で書き換えられていて、仮にマージすると衝突する。
    SquashedThenChanged { squash: String },
    /// 入っていない。
    NotContained,
}

/// 判定の結果。**先端を添える**のは、画面が「先端の組」で結果を覚えるため（T-38）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainmentOutcome {
    pub branch: String,
    pub target: String,
    pub branch_tip: String,
    pub target_tip: String,
    pub containment: Containment,
    pub elapsed_ms: u64,
}

/// `branch` が `target` に取り込まれているかを調べる。どちらも**完全な ref 名**。
///
/// ref はスナップショットから引く。**フロントから SHA やパスは受け取らない**（CLAUDE.md §4）。
pub fn check(
    log: &dyn LogSink,
    program: &str,
    path: &Path,
    snapshot: &RepositorySnapshot,
    branch: &str,
    target: &str,
) -> Result<ContainmentOutcome, String> {
    check_in(log, program, path, snapshot, branch, target, &std::env::temp_dir())
}

/// [`check`] の一時フォルダの置き場所を渡せるもの。**テストで「残らない」ことを見る**ため
/// （OS の一時フォルダは並行して走る他のテストと共有なので、そこでは数えられない）。
pub fn check_in(
    log: &dyn LogSink,
    program: &str,
    path: &Path,
    snapshot: &RepositorySnapshot,
    branch: &str,
    target: &str,
    scratch_parent: &Path,
) -> Result<ContainmentOutcome, String> {
    let started = Instant::now();
    if branch == target {
        return Err(format!("同じブランチどうしは比べられません: {branch}"));
    }
    let branch_tip = tip_of(snapshot, branch)?;
    let target_tip = tip_of(snapshot, target)?;
    let index = CommitIndex::new(&snapshot.commits);

    let containment = judge(log, program, path, &index, &branch_tip, &target_tip, scratch_parent)?;
    Ok(ContainmentOutcome {
        branch: branch.to_string(),
        target: target.to_string(),
        branch_tip,
        target_tip,
        containment,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// ブランチの ref から先端を引く。**タグは相手にも調べる対象にもしない**（起点 ref ではない）。
fn tip_of(snapshot: &RepositorySnapshot, name: &str) -> Result<String, String> {
    let entry = snapshot
        .refs
        .iter()
        .find(|entry| entry.name == name && entry.kind != RefKind::Tag)
        .ok_or_else(|| format!("ブランチが見つかりません: {name}"))?;
    if entry.out_of_graph {
        return Err(format!("読み込んだ履歴に無いブランチです: {name}"));
    }
    Ok(entry.target.clone())
}

fn judge(
    log: &dyn LogSink,
    program: &str,
    path: &Path,
    index: &CommitIndex<'_>,
    branch_tip: &str,
    target_tip: &str,
    scratch_parent: &Path,
) -> Result<Containment, String> {
    // 1. 普通にマージ済み。**git を呼ばない**（メモリ上の祖先関係。CLAUDE.md §2）。
    let (ahead, _) = index
        .ahead_behind(branch_tip, target_tip)
        .ok_or("読み込んだ履歴に無いコミットです")?;
    if ahead == 0 {
        return Ok(Containment::Ancestor);
    }

    // 履歴を共有しなければ取り込まれようがない。merge-tree は「無関係な履歴」で断るので先に決める。
    let Some(base) = merge_base(log, program, path, target_tip, branch_tip)? else {
        return Ok(Containment::NotContained);
    };

    let scratch = ScratchDir::new_in(scratch_parent)?;
    let probe = MergeProbe::new(log, program, path, target_tip, &scratch)?;
    let squash_finder = SquashFinder {
        log,
        program,
        path,
        base: &base,
        target_tip,
    };

    // 2. ③ 先端をそのままマージして、相手と同じ中身か。
    if probe.contains(branch_tip)? {
        let tip = index.get(branch_tip).ok_or("読み込んだ履歴に無いコミットです")?;
        return Ok(Containment::Contained {
            squash: squash_finder.find(tip)?,
        });
    }

    // 3. ②でブランチ全体と同じ変更を探す（squash の後、相手で書き換えられた場合）。
    //    **二分探索より先に見る。** 相手が squash の**すぐ隣の行**を書き換えると、git のマージは
    //    隣り合う変更を衝突として扱うので、③は途中のコミットでも外れ、「3 個中 1 個まで」の
    //    ような誤った答えになる（テストの囮で踏んだ。docs/DESIGN.md §17.1）。ブランチ全体と
    //    同じ squash が見つかるなら、そちらのほうが強い証拠。
    let tip = index.get(branch_tip).ok_or("読み込んだ履歴に無いコミットです")?;
    if let Some(squash) = squash_finder.find(tip)? {
        return Ok(Containment::SquashedThenChanged { squash });
    }

    // 4. どこまでなら入っているか。分岐点から先端までの第一親を二分探索する
    //    （squash の後にブランチへ足した場合。全体の差分は squash と一致しないので 3. では外れる）。
    let chain = first_parent_chain(index, branch_tip, target_tip);
    if let Some(found) = first_contained(chain.len(), |i| probe.contains(&chain[i].sha))? {
        return Ok(Containment::Partial {
            upto: (chain.len() - found) as u32,
            total: chain.len() as u32,
            squash: squash_finder.find(chain[found])?,
        });
    }

    // 5. どちらの手がかりでも見つからない。
    Ok(Containment::NotContained)
}

/// 先端から第一親を辿り、**相手から届くコミットに着く手前まで**を並べる（先頭が先端）。
fn first_parent_chain<'a>(
    index: &CommitIndex<'a>,
    branch_tip: &str,
    target_tip: &str,
) -> Vec<&'a CommitMeta> {
    let reachable = index.reachable_from(&[target_tip.to_string()]);
    let mut chain = Vec::new();
    let mut current = index.get(branch_tip);
    while let Some(commit) = current {
        if reachable.contains(commit.sha.as_str()) {
            break;
        }
        chain.push(commit);
        current = commit.parents.first().and_then(|parent| index.get(parent));
    }
    chain
}

/// `0..len` のうち、`contains(i)` が真になる**いちばん小さい添字**を二分探索で探す。
///
/// **添字 0（先端）は偽と分かっている前提**で、1 から探す。「新しいコミットが入っていれば、
/// それより古いコミットも入っている」という単調さを当てにする。**いちばん古い添字が偽なら、
/// どこも入っていない**ので `None`（探索に入らない）。
pub fn first_contained<E>(
    len: usize,
    mut contains: impl FnMut(usize) -> Result<bool, E>,
) -> Result<Option<usize>, E> {
    if len < 2 || !contains(len - 1)? {
        return Ok(None);
    }
    // 不変条件: `low` は偽、`high` は真。
    let (mut low, mut high) = (0, len - 1);
    while high - low > 1 {
        let middle = low + (high - low) / 2;
        if contains(middle)? {
            high = middle;
        } else {
            low = middle;
        }
    }
    Ok(Some(high))
}

/// `git merge-base`。**共通の祖先が無ければ `None`**（終了コード 1）。
fn merge_base(
    log: &dyn LogSink,
    program: &str,
    path: &Path,
    a: &str,
    b: &str,
) -> Result<Option<String>, String> {
    let output = exec::run(log, program, Some(path), &["merge-base", a, b])?;
    match output.exit_code {
        Some(0) => Ok(Some(output.stdout_lossy().trim().to_string())),
        Some(1) => Ok(None),
        _ => Err(output.failure("分岐点を調べられませんでした")),
    }
}

/// ③。相手に仮にマージして、中身が変わらないかを見る。
struct MergeProbe<'a> {
    log: &'a dyn LogSink,
    program: &'a str,
    path: &'a Path,
    target_tip: &'a str,
    target_tree: String,
    scratch: &'a ScratchDir,
    objects: String,
}

impl<'a> MergeProbe<'a> {
    fn new(
        log: &'a dyn LogSink,
        program: &'a str,
        path: &'a Path,
        target_tip: &'a str,
        scratch: &'a ScratchDir,
    ) -> Result<Self, String> {
        let tree_arg = format!("{target_tip}^{{tree}}");
        let tree = exec::run(log, program, Some(path), &["rev-parse", "--verify", &tree_arg])?;
        if !tree.ok() {
            return Err(tree.failure("相手の中身を読めませんでした"));
        }
        // worktree でも正しい場所を返す（`.git` がファイルのとき、オブジェクトは共通の場所にある）。
        let objects = exec::run(
            log,
            program,
            Some(path),
            &["rev-parse", "--path-format=absolute", "--git-path", "objects"],
        )?;
        if !objects.ok() {
            return Err(objects.failure("オブジェクトの置き場所を読めませんでした"));
        }
        Ok(Self {
            log,
            program,
            path,
            target_tip,
            target_tree: tree.stdout_lossy().trim().to_string(),
            scratch,
            objects: objects.stdout_lossy().trim().to_string(),
        })
    }

    /// `rev` を相手にマージした結果が、相手と同じ中身か。**衝突したら偽**。
    fn contains(&self, rev: &str) -> Result<bool, String> {
        // **新しいオブジェクトは一時フォルダへ、既存のオブジェクトは読むだけ。**
        // これを外すと、リポジトリの objects に tree が書き込まれる（テストで確かめてある）。
        let env: [(&str, &OsStr); 2] = [
            ("GIT_OBJECT_DIRECTORY", self.scratch.path().as_os_str()),
            ("GIT_ALTERNATE_OBJECT_DIRECTORIES", OsStr::new(&self.objects)),
        ];
        let output = exec::run_with_env(
            self.log,
            self.program,
            Some(self.path),
            &["merge-tree", "--write-tree", self.target_tip, rev],
            &env,
        )?;
        match output.exit_code {
            // 衝突なし。1 行目が結果の tree。
            Some(0) => {
                let stdout = output.stdout_lossy();
                Ok(stdout.lines().next().map(str::trim) == Some(self.target_tree.as_str()))
            }
            // 衝突あり。**相手と同じ中身にはなっていない。**
            Some(1) => Ok(false),
            _ => Err(output.failure("仮のマージを試せませんでした")),
        }
    }
}

/// ②。ブランチの差分と同じ変更を持つコミットを、相手の側から探す。
struct SquashFinder<'a> {
    log: &'a dyn LogSink,
    program: &'a str,
    path: &'a Path,
    base: &'a str,
    target_tip: &'a str,
}

impl SquashFinder<'_> {
    /// 分岐点から `upto` までの変更と同じ変更を持つ、相手側のコミット。
    fn find(&self, upto: &CommitMeta) -> Result<Option<String>, String> {
        let wanted = self.signature(self.base, &upto.sha)?;
        if wanted.is_empty() {
            return Ok(None);
        }
        let files: BTreeSet<&str> = wanted.keys().map(String::as_str).collect();

        let range = format!("{}..{}", self.base, self.target_tip);
        let output = exec::run(
            self.log,
            self.program,
            Some(self.path),
            &[
                "log",
                "--no-merges",
                "--no-renames",
                "--name-only",
                "-z",
                "--format=%x1e%H%x1f%ct",
                &range,
            ],
        )?;
        if !output.ok() {
            return Err(output.failure("相手のコミットを読めませんでした"));
        }

        let candidates = parse_candidates(&output.stdout_lossy())
            .into_iter()
            // squash はブランチの最後のコミットより後にしか起きない。
            .filter(|candidate| candidate.commit_time >= upto.commit_time)
            .filter(|candidate| {
                candidate.files.iter().map(String::as_str).collect::<BTreeSet<_>>() == files
            })
            .take(MAX_CANDIDATES);

        for candidate in candidates {
            let parent = format!("{}^", candidate.sha);
            if self.signature(&parent, &candidate.sha)? == wanted {
                return Ok(Some(candidate.sha));
            }
        }
        Ok(None)
    }

    fn signature(&self, from: &str, to: &str) -> Result<Signature, String> {
        let output = exec::run(
            self.log,
            self.program,
            Some(self.path),
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "-U0",
                from,
                to,
            ],
        )?;
        if !output.ok() {
            return Err(output.failure("差分を読めませんでした"));
        }
        Ok(signature(&String::from_utf8_lossy(&output.stdout)))
    }
}

/// ②で比べる相手 1 件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub sha: String,
    pub commit_time: i64,
    pub files: Vec<String>,
}

/// `log --name-only -z --format=%x1e%H%x1f%ct` の出力を分解する。
///
/// 1 件は `\x1e` で始まり、`SHA \x1f 時刻 NUL 改行` のあとにファイル名が NUL 区切りで続く
/// （git 2.43 で確かめた形）。**壊れたレコードは飛ばす。**
pub fn parse_candidates(stdout: &str) -> Vec<Candidate> {
    stdout
        .split('\u{1e}')
        .filter_map(|record| {
            let mut parts = record.split('\0');
            let header = parts.next()?;
            let (sha, time) = header.split_once('\u{1f}')?;
            let sha = sha.trim();
            if sha.is_empty() {
                return None;
            }
            let files = parts
                .map(|name| name.trim_start_matches('\n'))
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect();
            Some(Candidate {
                sha: sha.to_string(),
                commit_time: time.trim().parse().ok()?,
                files,
            })
        })
        .collect()
}

/// 差分の「指紋」。ファイルごとに、**足した行と消した行だけ**を並べたもの。
///
/// **行番号と前後の文脈は見ない。** 相手が別の場所で進んでいると、同じ変更でも行番号と
/// 文脈が変わる（squash の後に相手が進むのはふつうのこと）。`index` 行（blob の SHA）も
/// 前後のファイル全体で変わるので落とす。モードの変更と「バイナリが変わった」は残す。
pub type Signature = BTreeMap<String, Vec<String>>;

pub fn signature(diff: &str) -> Signature {
    let mut result: Signature = BTreeMap::new();
    let mut current: Option<String> = None;
    let mut in_hunk = false;

    for line in diff.split('\n') {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            // `--no-renames` なので `a/P b/P` の P は同じ。比べるのは同じ出し方どうしなので、
            // 取り出さずにそのまま鍵にする（引用符で囲まれた名前でも崩れない）。
            let key = file_key(rest);
            result.entry(key.clone()).or_default();
            current = Some(key);
            in_hunk = false;
            continue;
        }
        let Some(file) = current.as_ref() else {
            continue;
        };
        if line.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        let lines = result.entry(file.clone()).or_default();
        if in_hunk {
            // 足した行と消した行だけ。「末尾に改行が無い」印も文脈なので見ない。
            if line.starts_with('+') || line.starts_with('-') {
                lines.push(line.to_string());
            }
        } else if line.starts_with("index ") || line.starts_with("--- ") || line.starts_with("+++ ") {
            // 文脈に依るもの。見ない。
        } else if !line.is_empty() {
            // `new file mode` / `deleted file mode` / `old mode` / `Binary files … differ` など。
            lines.push(line.to_string());
        }
    }
    result
}

/// `a/P b/P` から P を取り出す。形が崩れていれば全体を鍵にする。
fn file_key(rest: &str) -> String {
    // `a/` + P + ` b/` + P なので、長さは 5 + 2 × |P|。
    let len = rest.len();
    if len >= 5 && (len - 5).is_multiple_of(2) {
        let name_len = (len - 5) / 2;
        if rest.is_char_boundary(2) && rest.is_char_boundary(2 + name_len) {
            let first = &rest[2..2 + name_len];
            if rest.starts_with("a/") && rest[2 + name_len..].starts_with(" b/") && rest.ends_with(first) {
                return first.to_string();
            }
        }
    }
    rest.to_string()
}

#[cfg(test)]
mod tests {
    use super::{first_contained, parse_candidates, signature, Containment, ContainmentOutcome};

    #[test]
    fn finds_the_first_contained_commit_by_bisecting() {
        // 添字 0 が先端。3 から後ろ（古い側）は入っている。
        for len in 4..40 {
            let mut calls = 0;
            let found = first_contained::<()>(len, |i| {
                calls += 1;
                Ok(i >= 3)
            })
            .unwrap();
            assert_eq!(found, Some(3), "len = {len}");
            // 二分探索なので、全部を試さない。
            assert!(calls <= 2 + (len as f64).log2().ceil() as usize, "len = {len}: {calls} 回");
        }
    }

    #[test]
    fn nothing_is_contained_when_the_oldest_is_not() {
        let mut calls = 0;
        let found = first_contained::<()>(20, |_| {
            calls += 1;
            Ok(false)
        })
        .unwrap();
        assert_eq!(found, None);
        // いちばん古いものが偽なら、探索に入らない。
        assert_eq!(calls, 1);
    }

    #[test]
    fn a_single_commit_branch_has_nothing_to_bisect() {
        // 先端（添字 0）は偽と分かっているので、1 個しか無ければ試すものが無い。
        let found = first_contained::<()>(1, |_| panic!("呼んではいけない")).unwrap();
        assert_eq!(found, None);
    }

    #[test]
    fn the_same_change_at_other_line_numbers_has_the_same_signature() {
        // 相手が先に別の行を足していると、同じ変更でも行番号が変わる。
        let on_branch = "diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -2 +2 @@\n-b\n+B1\n";
        let on_target = "diff --git a/f.txt b/f.txt\nindex 3333333..4444444 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -7 +7 @@\n-b\n+B1\n";
        assert_eq!(signature(on_branch), signature(on_target));
    }

    #[test]
    fn a_different_change_has_a_different_signature() {
        let one = "diff --git a/f.txt b/f.txt\n@@ -2 +2 @@\n-b\n+B1\n";
        let other = "diff --git a/f.txt b/f.txt\n@@ -2 +2 @@\n-b\n+B2\n";
        assert_ne!(signature(one), signature(other));
        // 同じ変更でも、別のファイルなら違う。
        let elsewhere = "diff --git a/g.txt b/g.txt\n@@ -2 +2 @@\n-b\n+B1\n";
        assert_ne!(signature(one), signature(elsewhere));
    }

    #[test]
    fn a_removed_line_that_looks_like_a_header_is_still_a_change() {
        // `-- ` で始まる行を消すと `--- ` になる。ヘッダと取り違えて落とさない。
        let diff = "diff --git a/f.sql b/f.sql\n--- a/f.sql\n+++ b/f.sql\n@@ -1 +0,0 @@\n--- comment\n";
        let lines = &signature(diff)["f.sql"];
        assert_eq!(lines, &vec!["--- comment".to_string()]);
    }

    #[test]
    fn a_new_file_keeps_its_mode_line() {
        let diff = "diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+new\n";
        assert_eq!(
            signature(diff)["n.txt"],
            vec!["new file mode 100644".to_string(), "+new".to_string()]
        );
    }

    #[test]
    fn a_path_with_spaces_is_kept_whole() {
        let diff = "diff --git a/dir x/a b.txt b/dir x/a b.txt\n@@ -1 +1 @@\n-x\n+y\n";
        assert!(signature(diff).contains_key("dir x/a b.txt"));
    }

    #[test]
    fn parses_candidates_with_their_files() {
        // git 2.43 の実際の形（`od -c` で確かめたもの）。
        let stdout = "\u{1e}aaa\u{1f}1767225600\0\nother.txt\0\u{1e}bbb\u{1f}1767225601\0\nf.txt\0n.txt\0";
        let found = parse_candidates(stdout);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].sha, "aaa");
        assert_eq!(found[0].files, vec!["other.txt".to_string()]);
        assert_eq!(found[1].commit_time, 1767225601);
        assert_eq!(found[1].files, vec!["f.txt".to_string(), "n.txt".to_string()]);
        assert!(parse_candidates("").is_empty());
    }

    /// 返す形がフロントの読む形であること（T-38 が読む）。
    #[test]
    fn the_outcome_wire_format_is_what_the_front_end_reads() {
        let outcome = ContainmentOutcome {
            branch: "refs/heads/feature".to_string(),
            target: "refs/heads/main".to_string(),
            branch_tip: "a".repeat(40),
            target_tip: "b".repeat(40),
            containment: Containment::Partial {
                upto: 3,
                total: 4,
                squash: Some("c".repeat(40)),
            },
            elapsed_ms: 12,
        };
        let json = serde_json::to_value(&outcome).expect("JSON にできること");
        assert_eq!(json["branchTip"], "a".repeat(40));
        assert_eq!(json["targetTip"], "b".repeat(40));
        assert_eq!(json["elapsedMs"], 12);
        // **`rename_all` は変種の名前しか変えない。** フィールドまで camelCase か見る。
        assert_eq!(json["containment"]["kind"], "partial");
        assert_eq!(json["containment"]["upto"], 3);
        assert_eq!(json["containment"]["squash"], "c".repeat(40));

        let changed = serde_json::to_value(Containment::SquashedThenChanged {
            squash: "d".repeat(40),
        })
        .unwrap();
        assert_eq!(changed["kind"], "squashedThenChanged");
        assert_eq!(serde_json::to_value(Containment::Ancestor).unwrap()["kind"], "ancestor");
        assert_eq!(
            serde_json::to_value(Containment::NotContained).unwrap()["kind"],
            "notContained"
        );
    }
}
