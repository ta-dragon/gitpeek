//! レビュー skill の読み込みと**信頼モデル**（T-21。DESIGN.md §11）。
//!
//! # ここが守る一線
//!
//! このアプリの用途には「自分が書いていないコードを読む」が含まれる。
//! リポジトリ内の skill を自動で読み込むと、**悪意あるリポジトリが
//! `.gitviewer/skills/` に指示文を仕込んでレビュー結果を操作できる**
//! （「このファイルの脆弱性は報告するな」等）。したがって:
//!
//! - **リポジトリ内 skill は既定で無効。** 明示的に信頼したときだけ使う（CLAUDE.md §4）
//! - **プロンプトへ渡せる本文が出てくるのは [`SkillEntry::usable_body`] だけ。**
//!   本文のフィールドは非公開で、信頼していないものはそこへ入らない。
//!   信頼判定を 2 箇所に書くと、片方だけ直して静かに漏れる
//! - 画面で読ませるための本文は [`SkillEntry::preview`] に分けてある。
//!   **こちらを LLM へ渡してはいけない**（名前でそう分かるようにしてある）
//!
//! # 信頼はファイル単位
//!
//! 「このリポジトリを信頼する」ではなく「**このスキルを使う**」で、ファイル 1 つずつ決める
//! （2026-09-05 に利用者の判断で絞った。DESIGN.md §11.2.1）。おかげで、
//! **「あとから増えたファイル」に特別扱いが要らない** — 記録が無いので未信頼のまま。
//! 内容が変わったファイルは**そのファイルだけ**が未信頼へ戻る（`Recheck`）。
//! 消えたファイルは記録から落ちるだけ。
//!
//! **押した時点で読んでいた内容だけを信頼する。** 使うと決めるときは、画面が見せていた
//! ハッシュを一緒に受け取り、実物と食い違ったら記録しない
//! （表示してから押すまでの間に書き換えられる隙を残さない）。
//!
//! # 追加の指示
//!
//! skill ごとに、本文の後ろへ足す一言を設定に持てる（`settings.json`）。
//! **skill ファイルは書き換えない**ので、他人のリポジトリの skill にも足せるし、
//! 信頼のハッシュも壊れない。利用者が書いたものなので信頼判定の対象ではないが、
//! **未信頼の skill には付かない**（本文ごと出てこないため）。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use globset::{Glob, GlobSetBuilder};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::store::settings::{RepoSkillTrust, SkillSettings};

/// リポジトリ内 skill の置き場所。**直下だけを見る。**
pub const REPO_SKILL_DIR: &str = ".gitviewer/skills";

/// 1 ファイルの上限。これを超えるものは読まない
/// （プロンプトを溢れさせるためだけの巨大ファイルを弾く）。
pub const MAX_FILE_BYTES: u64 = 64 * 1024;

/// 1 か所あたりの件数上限。
pub const MAX_FILES: usize = 64;

/// 内蔵 skill。**バイナリへ埋め込む**ので、消えることも古くなることもない。
const BUILT_IN: &str = include_str!("skills/general-review.md");

/// skill の出どころ。**画面に必ず出す** — どれが効いているのか読めなくなるため。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillOrigin {
    /// 同梱。編集できない。
    BuiltIn,
    /// `%APPDATA%\com.tatsu.givsoner\skills\`
    Global,
    /// `<repo>\.gitviewer\skills\`。**既定で無効。**
    Repository,
}

/// skill が使える状態か。**使えない理由まで持つ**（画面から消さずに理由を出すため）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SkillState {
    /// 使える。
    Ready,
    /// リポジトリ内で、まだ「使う」と決めていない。**増えたファイルもここ。**
    Untrusted,
    /// 一度は使うと決めたが、**そのファイルの内容が変わった**ので決め直しが要る。
    Recheck,
    /// 読めない。`reason` をそのまま画面へ出す。
    Unreadable { reason: String },
}

/// 一覧に出す 1 件。
///
/// **`body` は非公開。** プロンプトへ渡す本文は [`SkillEntry::usable_body`] からしか
/// 取り出せない（信頼していないものはそこが `None` になる）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    /// 表示名。読めなかったときはファイル名。
    pub name: String,
    pub description: String,
    pub globs: Vec<String>,
    /// frontmatter の `enabled`。**「既定 ON かどうか」であって「使えるか」ではない。**
    pub enabled: bool,
    pub origin: SkillOrigin,
    /// ファイル名。内蔵は空。
    pub file: String,
    pub state: SkillState,
    /// 同名の別の skill に隠されている場合、隠したほうの出どころ。
    pub shadowed_by: Option<SkillOrigin>,
    /// いま使うことになっているか。**ファイルの `enabled` ＋ 利用者の指定 ＋ 信頼**の結果。
    pub in_use: bool,
    /// `in_use` を**利用者が明示的に決めたか**。`false` ならファイルの既定のまま。
    pub decided_by_user: bool,
    /// 本文の後ろへ足す一言（`settings.json`）。無ければ空。
    pub extra: String,
    /// いまのファイル内容のハッシュ。内蔵は空。
    /// **「使う」と決めるときにこれを一緒に送る**（読んだ内容と食い違ったら記録しない）。
    pub hash: String,
    /// **信頼を決める前に読ませるための本文。LLM へ渡してはいけない。**
    /// 読ませずに使わせないために、未信頼でもここには入る。
    pub preview: String,
    /// **プロンプトへ渡してよい本文。** 信頼していないものはここへ入らない。
    /// フロントへは送らない（画面は `preview` を使う）。
    #[serde(skip)]
    body: Option<String>,
}

impl SkillEntry {
    /// **プロンプトへ渡してよい本文。** T-22 はここからしか本文を取れない。
    ///
    /// 「追加の指示」は本文の後ろに付いた形で返る。利用者が書いたものなので信頼判定の
    /// 対象ではないが、**未信頼の skill には付かない**（本文ごと `None` になるため）。
    pub fn usable_body(&self) -> Option<String> {
        let body = self.body.as_deref()?;
        if self.extra.trim().is_empty() {
            return Some(body.to_string());
        }
        Some(format!("{body}

{}", self.extra.trim()))
    }

    /// 一覧のうち**実際に使うもの**だけ。
    ///
    /// 隠された（同名で負けた）もの、信頼していないもの、使わないと決めたものは出てこない。
    pub fn active(entries: &[Self]) -> Vec<&Self> {
        entries
            .iter()
            .filter(|entry| entry.shadowed_by.is_none() && entry.in_use && entry.body.is_some())
            .collect()
    }
}

/// リポジトリ内 skill の様子。**画面はこれで見出しを出す。**
///
/// 信頼はファイル単位なので、ここにあるのは**数え上げだけ**。
/// 使う／使わないの判断は各 [`SkillEntry`] が持つ。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoTrustStatus {
    /// リポジトリ内に skill が 1 つでもあるか。
    pub present: bool,
    /// 使うと決めてあるファイル数。
    pub in_use: usize,
    /// まだ決めていないファイル（**あとから増えたものもここ**）。
    pub undecided: Vec<String>,
    /// 一度は使うと決めたが、**内容が変わった**ファイル。
    pub changed: Vec<String>,
}

/// 読み込み結果一式。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalog {
    pub entries: Vec<SkillEntry>,
    pub trust: RepoTrustStatus,
}

/// 内蔵 ＋ グローバル ＋ リポジトリ内を読む。
///
/// `repository` が `None` ならリポジトリ内は見ない（リポジトリ未選択）。
/// **信頼判定はここ 1 箇所**で、結果は各 `SkillEntry` の `state` と `body` に落ちる。
pub fn load(
    global_dir: &Path,
    repository: Option<&Path>,
    trust: &RepoSkillTrust,
    settings: &SkillSettings,
) -> SkillCatalog {
    let mut entries = vec![built_in()];
    entries.extend(read_dir(global_dir, SkillOrigin::Global));

    // 内蔵とグローバルは自分で置いたものなので、信頼は要らない。使うかどうかだけ。
    for entry in &mut entries {
        let decided = settings.use_skill.get(&entry.name).copied();
        entry.decided_by_user = decided.is_some();
        entry.in_use = decided.unwrap_or(entry.enabled);
        entry.extra = settings.extra.get(&entry.name).cloned().unwrap_or_default();
        entry.body = Some(entry.preview.clone());
    }

    let mut status = RepoTrustStatus::default();
    if let Some(root) = repository {
        for mut entry in read_dir(&repo_skill_dir(root), SkillOrigin::Repository) {
            status.present = true;
            entry.extra = trust.extra.get(&entry.file).cloned().unwrap_or_default();

            if matches!(entry.state, SkillState::Ready) {
                // **既定は「配らない」。** 記録と一致したときだけ本文を渡す。
                // 配り忘れは動かないだけで済むが、止め忘れは漏れる。
                match trust.hashes.get(&entry.file) {
                    Some(recorded) if *recorded == entry.hash => {
                        entry.in_use = true;
                        entry.decided_by_user = true;
                        entry.body = Some(entry.preview.clone());
                        status.in_use += 1;
                    }
                    // 一度は使うと決めたが、内容が変わった。**そのファイルだけ**戻す。
                    Some(_) => {
                        entry.state = SkillState::Recheck;
                        status.changed.push(entry.file.clone());
                    }
                    // 記録が無い。**増えたファイルもここへ来る**（特別扱いが要らない）。
                    None => {
                        entry.state = SkillState::Untrusted;
                        status.undecided.push(entry.file.clone());
                    }
                }
            } else {
                // 読めないファイルも「決めていない」として数える。**見せずに済ませない。**
                status.undecided.push(entry.file.clone());
            }
            entries.push(entry);
        }
    }

    mark_shadowed(&mut entries);
    SkillCatalog {
        entries,
        trust: status,
    }
}

/// `<repo>\.gitviewer\skills`
pub fn repo_skill_dir(repository: &Path) -> PathBuf {
    let mut dir = repository.to_path_buf();
    for segment in REPO_SKILL_DIR.split('/') {
        dir.push(segment);
    }
    dir
}

/// 1 ファイルのいまのハッシュ。「使う」と決めるときの照合に使う。
///
/// **画面が見せていたハッシュと突き合わせてから記録する。** 表示してから押すまでの間に
/// 書き換えられると、読んでいない内容を信頼したことになる。
pub fn file_hash(repository: &Path, file: &str) -> Option<String> {
    // ディレクトリを一覧し直して、**直下の通常ファイルであること**をもう一度確かめる。
    // パスを直接組み立てると `..` や symlink をここだけ素通しさせてしまう。
    read_dir(&repo_skill_dir(repository), SkillOrigin::Repository)
        .into_iter()
        .find(|entry| entry.file == file)
        .map(|entry| entry.hash)
}

/// `globs` が**この変更に当てはまるか**。
///
/// **使うかどうか（`in_use`）とは別の話。** 使うと決めた skill のうち、
/// この変更に関係するものだけを T-22 が実際に渡す。
///
/// パスは `/` 区切りへ均す。**Windows の `\` のまま当てると `**\/*.ts` が 1 件も当たらない。**
pub fn matches_changes(entry: &SkillEntry, changed_paths: &[String]) -> bool {
    // 観点を絞らない skill はどの変更にも当てはまる。
    if entry.globs.is_empty() {
        return true;
    }

    let mut builder = GlobSetBuilder::new();
    for pattern in &entry.globs {
        match Glob::new(pattern) {
            Ok(glob) => {
                builder.add(glob);
            }
            // 読み込み時に検証済みなので通常は来ない。来たら当てない側へ倒す。
            Err(_) => return false,
        }
    }
    let Ok(set) = builder.build() else {
        return false;
    };

    changed_paths
        .iter()
        .any(|path| set.is_match(path.replace('\\', "/")))
}

fn built_in() -> SkillEntry {
    // 同梱物なので読めないことはない。読めなければビルドの間違い。
    let parsed = parse(BUILT_IN).expect("内蔵 skill が読めない");
    entry_from(parsed, SkillOrigin::BuiltIn, String::new(), String::new())
}

/// ディレクトリ直下の `*.md` を読む。
///
/// **サブディレクトリと symlink を辿らない。** `.md` の名前で秘密鍵を指されると、
/// その中身がプロンプトへ入る。
fn read_dir(dir: &Path, origin: SkillOrigin) -> Vec<SkillEntry> {
    let Ok(listing) = std::fs::read_dir(dir) else {
        // 無いのは異常ではない（skill を置いていないリポジトリのほうが多い）。
        return Vec::new();
    };

    let mut files: Vec<(String, PathBuf, u64)> = Vec::new();
    for item in listing.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        if !name.to_ascii_lowercase().ends_with(".md") {
            continue;
        }
        // `DirEntry::file_type` はリンクを辿らないので、ここで symlink を落とせる。
        let Ok(kind) = item.file_type() else { continue };
        if kind.is_symlink() || !kind.is_file() {
            continue;
        }
        let size = item.metadata().map(|meta| meta.len()).unwrap_or(u64::MAX);
        files.push((name, item.path(), size));
    }
    // 並びを決めておく。読む順で結果が変わると、同名の勝ち負けが日によって変わる。
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut entries = Vec::new();
    for (index, (name, path, size)) in files.into_iter().enumerate() {
        if index >= MAX_FILES {
            entries.push(unreadable(
                &name,
                origin,
                format!("1 か所に置ける skill は {MAX_FILES} 個までです。"),
                String::new(),
            ));
            continue;
        }
        if size > MAX_FILE_BYTES {
            entries.push(unreadable(
                &name,
                origin,
                format!(
                    "ファイルが大きすぎます（{} KiB。上限は {} KiB）。",
                    size / 1024,
                    MAX_FILE_BYTES / 1024
                ),
                String::new(),
            ));
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            entries.push(unreadable(
                &name,
                origin,
                "テキストとして読めません（UTF-8 で保存してください）。".to_string(),
                String::new(),
            ));
            continue;
        };
        match parse_named(&text, &name) {
            Ok(parsed) => entries.push(entry_from(parsed, origin, name, sha256(&text))),
            Err(reason) => entries.push(unreadable(&name, origin, reason, sha256(&text))),
        }
    }
    entries
}

/// 同名なら**リポジトリ内 → グローバル → 内蔵**の順に勝つ。
///
/// **勝てるのは使えるものだけ。** 未信頼のリポジトリ内 skill が、同名のグローバルを
/// 押しのけてはいけない（何も使えなくなる）。
fn mark_shadowed(entries: &mut [SkillEntry]) {
    let mut winners: BTreeMap<String, usize> = BTreeMap::new();
    for index in 0..entries.len() {
        // **勝てるのは実際に使うものだけ。** 使わないものが同名を押しのけると、
        // 決めていないだけで何も使えなくなる。
        if !entries[index].in_use || entries[index].body.is_none() {
            continue;
        }
        let name = entries[index].name.clone();
        match winners.get(&name).copied() {
            Some(previous) if rank(entries[previous].origin) >= rank(entries[index].origin) => {
                // 既にいるほうが強い（同順なら先に読んだほうを残す）。
                let winner = entries[previous].origin;
                entries[index].shadowed_by = Some(winner);
            }
            Some(previous) => {
                let loser = entries[index].origin;
                entries[previous].shadowed_by = Some(loser);
                winners.insert(name, index);
            }
            None => {
                winners.insert(name, index);
            }
        }
    }
}

fn rank(origin: SkillOrigin) -> u8 {
    match origin {
        SkillOrigin::BuiltIn => 0,
        SkillOrigin::Global => 1,
        SkillOrigin::Repository => 2,
    }
}

/// 読めた 1 件。**`body` はここでは入れない** — 使うと決まってから `load` が渡す。
fn entry_from(parsed: Parsed, origin: SkillOrigin, file: String, hash: String) -> SkillEntry {
    SkillEntry {
        name: parsed.name,
        description: parsed.description,
        globs: parsed.globs,
        enabled: parsed.enabled,
        origin,
        file,
        state: SkillState::Ready,
        shadowed_by: None,
        in_use: false,
        decided_by_user: false,
        extra: String::new(),
        hash,
        body: None,
        preview: parsed.body,
    }
}

fn unreadable(file: &str, origin: SkillOrigin, reason: String, hash: String) -> SkillEntry {
    SkillEntry {
        name: file.to_string(),
        description: String::new(),
        globs: Vec::new(),
        enabled: false,
        origin,
        file: file.to_string(),
        state: SkillState::Unreadable { reason },
        shadowed_by: None,
        in_use: false,
        decided_by_user: false,
        extra: String::new(),
        hash,
        body: None,
        preview: String::new(),
    }
}

fn sha256(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// パースの結果。
#[derive(Debug, Clone, PartialEq)]
struct Parsed {
    name: String,
    description: String,
    globs: Vec<String>,
    enabled: bool,
    body: String,
}

fn parse(text: &str) -> Result<Parsed, String> {
    parse_named(text, "skill.md")
}

/// Markdown ＋ YAML frontmatter を読む。**4 キーの厳格なサブセットだけ。**
///
/// **知らないキーと読めない行は skill ごと弾く。** 黙って既定値へ倒すと、
/// レビュー観点が意図と違うまま静かに使われる。
fn parse_named(text: &str, file: &str) -> Result<Parsed, String> {
    // BOM 付きで保存されることがある。frontmatter の判定より先に落とす。
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    // CRLF はここで吸収する（行の比較を `---` で行うため）。
    let normalized = text.replace("\r\n", "\n");

    let (front, body) = match normalized.strip_prefix("---\n") {
        // frontmatter 無し。本文だけの skill として読み、名前はファイル名から採る。
        None => (None, normalized.as_str().trim_start_matches("---").trim()),
        Some(rest) => match rest.split_once("\n---\n") {
            Some((front, body)) => (Some(front), body.trim()),
            // 末尾が `---` で終わり本文が無い形も受ける。
            None => match rest.strip_suffix("\n---").or(rest.strip_suffix("\n---\n")) {
                Some(front) => (Some(front), ""),
                None => {
                    return Err("frontmatter が `---` で閉じていません。".to_string());
                }
            },
        },
    };

    let mut parsed = Parsed {
        name: default_name(file),
        description: String::new(),
        globs: Vec::new(),
        enabled: true,
        body: String::new(),
    };

    if let Some(front) = front {
        let mut seen: Vec<&str> = Vec::new();
        for (number, line) in front.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((key, value)) = line.split_once(':') else {
                return Err(format!(
                    "{} 行目を読めません（`キー: 値` の形だけを受け付けます）: {line}",
                    number + 1
                ));
            };
            let key = key.trim();
            let value = value.trim();
            if seen.contains(&key) {
                return Err(format!("`{key}` が 2 回書かれています。"));
            }
            seen.push(key);

            match key {
                "name" => parsed.name = unquote(value).to_string(),
                "description" => parsed.description = unquote(value).to_string(),
                "globs" => parsed.globs = parse_globs(value)?,
                "enabled" => {
                    parsed.enabled = match value {
                        "true" => true,
                        "false" => false,
                        other => {
                            return Err(format!(
                                "`enabled` は true か false だけです（`{other}` と書かれています）。"
                            ))
                        }
                    }
                }
                other => {
                    return Err(format!(
                        "`{other}` は使えないキーです（使えるのは name / description / globs / enabled だけです）。"
                    ))
                }
            }
        }
    }

    if parsed.name.is_empty() {
        return Err("`name` が空です。".to_string());
    }
    if body.trim().is_empty() {
        // 本文の無い skill は何も指示しない。読めたことにすると黙って効かない。
        return Err("本文がありません（`---` の後にレビュー観点を書いてください）。".to_string());
    }
    parsed.body = body.to_string();
    Ok(parsed)
}

/// `["a", "b"]` か、引用符付き / 裸の 1 つ。
fn parse_globs(value: &str) -> Result<Vec<String>, String> {
    if value.is_empty() {
        return Ok(Vec::new());
    }
    let patterns: Vec<String> = match value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
        Some(inner) if inner.trim().is_empty() => Vec::new(),
        Some(inner) => inner
            .split(',')
            .map(|item| unquote(item.trim()).to_string())
            .filter(|item| !item.is_empty())
            .collect(),
        None => vec![unquote(value).to_string()],
    };

    // **書けない glob をここで弾く。** 読み込み時に落としておかないと、
    // 「一覧には出るが 1 件も当たらない」という気付けない壊れ方をする。
    for pattern in &patterns {
        Glob::new(pattern)
            .map_err(|error| format!("`globs` の `{pattern}` を読めません: {error}"))?;
    }
    Ok(patterns)
}

fn unquote(value: &str) -> &str {
    for quote in ['"', '\''] {
        if let Some(inner) = value.strip_prefix(quote).and_then(|v| v.strip_suffix(quote)) {
            return inner;
        }
    }
    value
}

fn default_name(file: &str) -> String {
    file.strip_suffix(".md")
        .or_else(|| file.strip_suffix(".MD"))
        .unwrap_or(file)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 「使うと決めてある」1 件。
    fn ready(name: &str, origin: SkillOrigin, body: &str) -> SkillEntry {
        let mut entry = entry_from(
            Parsed {
                name: name.to_string(),
                description: String::new(),
                globs: Vec::new(),
                enabled: true,
                body: body.to_string(),
            },
            origin,
            format!("{name}.md"),
            sha256(body),
        );
        entry.in_use = true;
        entry.body = Some(entry.preview.clone());
        entry
    }

    #[test]
    fn the_built_in_skill_is_always_available() {
        let entry = built_in();
        assert_eq!(entry.origin, SkillOrigin::BuiltIn);
        assert_eq!(entry.name, "general-review");
        assert_eq!(entry.state, SkillState::Ready);
        assert!(entry.enabled);
        assert!(entry.globs.is_empty(), "観点を絞らないので常に既定 ON");
        // `load` を通す前は本文を配らない（配るのは信頼と選択を見てから）。
        assert_eq!(entry.usable_body(), None);
        assert!(entry.preview.contains("日本語"));
    }

    // ---- frontmatter --------------------------------------------------

    #[test]
    fn reads_a_normal_skill() {
        let parsed = parse(
            "---\nname: security-review\ndescription: セキュリティ観点\nglobs: [\"**/*.ts\", \"**/*.rs\"]\nenabled: true\n---\n\n本文です。\n",
        )
        .unwrap();
        assert_eq!(parsed.name, "security-review");
        assert_eq!(parsed.description, "セキュリティ観点");
        assert_eq!(parsed.globs, vec!["**/*.ts", "**/*.rs"]);
        assert!(parsed.enabled);
        assert_eq!(parsed.body, "本文です。");
    }

    /// frontmatter が無ければ**本文だけの skill**。名前はファイル名から採る。
    #[test]
    fn reads_a_skill_without_frontmatter() {
        let parsed = parse_named("観点だけ書いたファイル。\n", "my-review.md").unwrap();
        assert_eq!(parsed.name, "my-review");
        assert_eq!(parsed.body, "観点だけ書いたファイル。");
        assert!(parsed.enabled, "既定は ON");
    }

    /// **利用者が入れうる端の値**（T-20 の教訓）。
    #[test]
    fn rejects_files_that_say_nothing() {
        for (text, note) in [
            ("", "空ファイル"),
            ("   \n\n", "空白だけ"),
            ("---\nname: x\n---\n", "frontmatter だけで本文が無い"),
            ("---\nname: x\n---\n   \n", "本文が空白だけ"),
        ] {
            let error = parse(text).unwrap_err();
            assert!(error.contains("本文がありません"), "{note}: {error}");
        }
    }

    #[test]
    fn rejects_an_unclosed_frontmatter() {
        let error = parse("---\nname: x\n本文\n").unwrap_err();
        assert!(error.contains("閉じていません"), "{error}");
    }

    /// **知らないキーは黙って無視しない。** 意図と違う観点で静かに使われるより落とす。
    #[test]
    fn rejects_unknown_keys() {
        let error = parse("---\nname: x\nmodel: gpt-4o\n---\n本文\n").unwrap_err();
        assert!(error.contains("model"), "{error}");
        assert!(error.contains("使えないキー"), "{error}");
    }

    #[test]
    fn rejects_lines_that_are_not_key_value() {
        let error = parse("---\nname: x\nこれはただの行\n---\n本文\n").unwrap_err();
        assert!(error.contains("読めません"), "{error}");
    }

    #[test]
    fn rejects_a_duplicated_key() {
        let error = parse("---\nname: x\nname: y\n---\n本文\n").unwrap_err();
        assert!(error.contains("2 回"), "{error}");
    }

    #[test]
    fn rejects_an_enabled_that_is_not_a_boolean() {
        let error = parse("---\nname: x\nenabled: yes\n---\n本文\n").unwrap_err();
        assert!(error.contains("true か false"), "{error}");
        assert!(!parse("---\nname: x\nenabled: false\n---\n本文\n").unwrap().enabled);
    }

    #[test]
    fn rejects_an_empty_name() {
        assert!(parse("---\nname: \"\"\n---\n本文\n")
            .unwrap_err()
            .contains("`name` が空"));
    }

    /// `globs` は配列でも 1 つの文字列でも書ける。
    #[test]
    fn reads_globs_in_both_shapes() {
        assert_eq!(
            parse("---\nname: x\nglobs: \"**/*.rs\"\n---\n本文\n").unwrap().globs,
            vec!["**/*.rs"]
        );
        assert_eq!(
            parse("---\nname: x\nglobs: **/*.rs\n---\n本文\n").unwrap().globs,
            vec!["**/*.rs"]
        );
        assert!(parse("---\nname: x\nglobs: []\n---\n本文\n").unwrap().globs.is_empty());
    }

    /// **書けない glob は読み込み時に落とす。** 一覧に出るのに 1 件も当たらない形にしない。
    #[test]
    fn rejects_a_glob_that_cannot_be_compiled() {
        let error = parse("---\nname: x\nglobs: \"[unclosed\"\n---\n本文\n").unwrap_err();
        assert!(error.contains("globs"), "{error}");
    }

    /// BOM 付きと CRLF。どちらもエディタが勝手に付ける。
    #[test]
    fn reads_a_file_with_a_bom_and_crlf() {
        let parsed = parse("\u{feff}---\r\nname: x\r\ndescription: せつめい\r\n---\r\n\r\n本文\r\n")
            .unwrap();
        assert_eq!(parsed.name, "x");
        assert_eq!(parsed.description, "せつめい");
        assert_eq!(parsed.body, "本文");
    }

    /// **フロントが読む形を固定する。**
    ///
    /// T-18 は逆向き（フロント → Rust）で嵌まったが、こちらも同じで、
    /// 形が違えば画面は黙って空になる。あわせて
    /// **プロンプト用の本文がフロントへ渡らないこと**もここで押さえる。
    #[test]
    fn the_wire_format_matches_what_the_front_end_reads() {
        let catalog = SkillCatalog {
            entries: vec![ready("review", SkillOrigin::BuiltIn, "本文")],
            trust: RepoTrustStatus {
                present: true,
                in_use: 1,
                undecided: vec!["b.md".to_string()],
                changed: vec!["a.md".to_string()],
            },
        };
        let json = serde_json::to_value(&catalog).unwrap();

        let entry = &json["entries"][0];
        assert_eq!(entry["origin"], "builtIn");
        assert_eq!(entry["state"]["kind"], "ready");
        assert_eq!(entry["shadowedBy"], serde_json::Value::Null);
        assert_eq!(entry["preview"], "本文");
        assert!(entry["enabled"].is_boolean());
        assert!(entry["globs"].is_array());

        // **プロンプトへ渡す本文を webview へ送らない。** 画面は `preview` を使う。
        assert!(entry.get("body").is_none(), "{entry}");

        assert_eq!(entry["inUse"], true);
        assert!(entry["decidedByUser"].is_boolean());
        assert!(entry["extra"].is_string());
        assert!(entry["hash"].is_string());

        let trust = &json["trust"];
        assert_eq!(trust["inUse"], 1);
        assert_eq!(trust["changed"][0], "a.md");
        assert_eq!(trust["undecided"][0], "b.md");

        // 読めないものは理由まで届くこと。
        let broken = unreadable(
            "x.md",
            SkillOrigin::Repository,
            "本文がありません".to_string(),
            String::new(),
        );
        let json = serde_json::to_value(&broken).unwrap();
        assert_eq!(json["state"]["kind"], "unreadable");
        assert_eq!(json["state"]["reason"], "本文がありません");
    }

    // ---- 追加の指示 -----------------------------------------------------

    /// **追加の指示は本文の後ろへ付く。** skill ファイルは書き換えない。
    #[test]
    fn the_extra_instruction_rides_along_with_the_body() {
        let mut entry = ready("x", SkillOrigin::Global, "もとの観点");
        assert_eq!(entry.usable_body().as_deref(), Some("もとの観点"));

        entry.extra = "  日本語で書いてください。  ".to_string();
        assert_eq!(
            entry.usable_body().as_deref(),
            Some("もとの観点

日本語で書いてください。"),
            "前後の空白は落とす",
        );

        // 空白だけなら何も付けない（空行が 2 つ増えるだけになる）。
        entry.extra = "   
 ".to_string();
        assert_eq!(entry.usable_body().as_deref(), Some("もとの観点"));
    }

    /// **信頼していない skill には追加の指示も付かない。** 本文ごと出てこない。
    #[test]
    fn the_extra_instruction_does_not_leak_an_untrusted_skill() {
        let mut entry = ready("x", SkillOrigin::Repository, "未信頼の本文");
        entry.body = None;
        entry.in_use = false;
        entry.state = SkillState::Untrusted;
        entry.extra = "追加の指示".to_string();

        assert_eq!(entry.usable_body(), None);
        assert!(SkillEntry::active(&[entry]).is_empty());
    }

    /// 使わないと決めたものは `active` に出ない。**本文は持っていても出さない。**
    #[test]
    fn a_skill_that_is_not_in_use_is_not_active() {
        let mut entry = ready("x", SkillOrigin::Global, "本文");
        entry.in_use = false;
        assert!(SkillEntry::active(&[entry]).is_empty());
    }

    // ---- 同名の勝ち負け -------------------------------------------------

    #[test]
    fn a_trusted_repository_skill_shadows_the_global_one() {
        let mut entries = vec![
            ready("review", SkillOrigin::Global, "グローバル"),
            ready("review", SkillOrigin::Repository, "リポジトリ"),
        ];
        mark_shadowed(&mut entries);

        assert_eq!(entries[0].shadowed_by, Some(SkillOrigin::Repository));
        assert_eq!(entries[1].shadowed_by, None);
        let active = SkillEntry::active(&entries);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].usable_body().as_deref(), Some("リポジトリ"));
    }

    /// **未信頼のリポジトリ内 skill が、同名のグローバルを押しのけてはいけない。**
    /// 押しのけると、信頼していないだけで何も使えなくなる。
    #[test]
    fn an_untrusted_repository_skill_shadows_nothing() {
        let mut untrusted = ready("review", SkillOrigin::Repository, "リポジトリ");
        untrusted.body = None;
        untrusted.in_use = false;
        untrusted.state = SkillState::Untrusted;

        let mut entries = vec![ready("review", SkillOrigin::Global, "グローバル"), untrusted];
        mark_shadowed(&mut entries);

        assert_eq!(entries[0].shadowed_by, None);
        let active = SkillEntry::active(&entries);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].usable_body().as_deref(), Some("グローバル"));
    }

    // ---- globs ---------------------------------------------------------

    #[test]
    fn globs_narrow_by_changed_path() {
        let mut entry = ready("x", SkillOrigin::Global, "本文");
        entry.globs = vec!["**/*.ts".to_string()];

        assert!(matches_changes(&entry, &["src/app.ts".to_string()]));
        assert!(!matches_changes(&entry, &["src/app.rs".to_string()]));
        // 1 つでも当たれば ON。
        assert!(matches_changes(
            &entry,
            &["a.rs".to_string(), "b/c/d.ts".to_string()]
        ));
    }

    /// **Windows の `\` のまま当てると 1 件も当たらない。**
    #[test]
    fn globs_match_windows_separators_too() {
        let mut entry = ready("x", SkillOrigin::Global, "本文");
        entry.globs = vec!["**/*.rs".to_string()];
        assert!(matches_changes(&entry, &["src-tauri\\src\\llm\\skill.rs".to_string()]));
    }

    #[test]
    fn a_skill_without_globs_matches_anything() {
        let entry = ready("x", SkillOrigin::Global, "本文");
        assert!(matches_changes(&entry, &[]));
        assert!(matches_changes(&entry, &["anything".to_string()]));
    }

    /// **`globs` は「使うか」とは別。** `enabled: false` の skill でも、
    /// 利用者が使うと決めたなら当たり判定は当たる（使うかどうかは `in_use` が決める）。
    #[test]
    fn globs_do_not_care_whether_the_skill_is_in_use() {
        let mut entry = ready("x", SkillOrigin::Global, "本文");
        entry.enabled = false;
        entry.globs = vec!["**/*.ts".to_string()];
        assert!(matches_changes(&entry, &["a.ts".to_string()]));
        assert!(!matches_changes(&entry, &["a.rs".to_string()]));
    }
}
