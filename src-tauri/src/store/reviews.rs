//! レビュー結果の永続化（T-23。docs/DESIGN.md §12.4 / CLAUDE.md §5）。
//!
//! `%APPDATA%\com.tatsu.gitpeek\reviews\<repo-id>\<日時>-<runId の先頭 8 桁>.json`
//!
//! ここが守っていること:
//!
//! - **上書きせず積む。** モデルや skill を変えて同じ差分をレビューし直し、
//!   結果を見比べたくなる場面が多い（DESIGN.md §12.4）
//! - **保存するのは [`crate::llm::review::ReviewRun`] をそのまま包んだもの。**
//!   §12.4 は別の形の JSON を案として書いていたが、`ReviewRun` が同じ内容を
//!   持っているので変換しない（変換器を両側に合わせ続けることになる）。
//!   包む側が `schemaVersion` / `repositoryId` / `savedAt` / プロファイルの控えを足す
//! - **base URL は `redact` を通してから書く**（CLAUDE.md §4）。
//!   `https://user:token@host` を貼られていても平文で残さない
//! - **壊れた 1 件で一覧を落とさない。** 読めないものは理由付きで並べる
//!   （skill の一覧と同じ扱い。CLAUDE.md §6）

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::git::diff::DiffSource;
use crate::llm::review::ReviewRun;
use crate::redact::redact;
use crate::store::json;
use crate::store::paths::StorePaths;
use crate::store::settings::LlmProfile;

/// 保存する JSON のスキーマ版。**読めない将来版は理由付きで一覧に残す。**
pub const SCHEMA_VERSION: u32 = 1;

/// 実行時に使ったプロファイルの控え。
///
/// **ID だけでは後から読めない**（プロファイルを消したら何も分からなくなる）ので、
/// 名前・モデル・接続先を一緒に残す。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfileSnapshot {
    pub name: String,
    pub model: String,
    /// **`redact` を通したもの。** 資格情報付き URL の平文を残さない。
    pub base_url: String,
}

impl ProfileSnapshot {
    pub fn of(profile: &LlmProfile) -> Self {
        Self {
            name: profile.name.clone(),
            model: profile.model.clone(),
            base_url: redact(&profile.base_url),
        }
    }
}

/// 保存した 1 件。**フロントはこれを受け取ってそのまま表示する。**
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredReview {
    pub schema_version: u32,
    pub repository_id: String,
    /// 保存した時刻（ISO 8601 / ローカル時刻）。
    pub saved_at: String,
    /// 保存したファイル名。**一覧から開くときの鍵。**
    pub file: String,
    pub profile: ProfileSnapshot,
    pub run: ReviewRun,
}

/// 履歴一覧の 1 行。**全文を持たない。**
///
/// 読めなかったものも `unreadable` を入れて並べる（画面から消さない）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReviewIndexRow {
    pub file: String,
    pub saved_at: String,
    pub model: String,
    pub profile_name: String,
    /// 何と何を比べたか。**当時の差分を出し直すのに使う。**
    pub source: Option<DiffSource>,
    pub files: usize,
    pub findings: usize,
    pub failed: usize,
    pub cancelled: bool,
    /// 読めなかった理由。`None` なら読めている。
    pub unreadable: Option<String>,
}

/// 保存する。**同じ組み合わせでも上書きしない。**
pub fn save(
    paths: &StorePaths,
    repository_id: &str,
    profile: &LlmProfile,
    run: ReviewRun,
) -> Result<StoredReview, String> {
    let dir = paths.review_dir(repository_id);
    let saved_at = chrono::Local::now();
    let file = unique_name(&dir, &saved_at, &run.run_id);

    let stored = StoredReview {
        schema_version: SCHEMA_VERSION,
        repository_id: repository_id.to_string(),
        saved_at: saved_at.to_rfc3339(),
        file,
        profile: ProfileSnapshot::of(profile),
        run,
    };
    json::write_pretty(&dir.join(&stored.file), &stored)?;
    Ok(stored)
}

/// 使えるファイル名を決める。
///
/// **時刻だけだと同じ秒に 2 件で衝突する**ので `runId` の先頭 8 桁を足す。
/// それでも在ったら連番を付ける（**既にあるものを絶対に潰さない**）。
fn unique_name(dir: &Path, at: &chrono::DateTime<chrono::Local>, run_id: &str) -> String {
    let stamp = at.format("%Y%m%dT%H%M%S");
    let short: String = run_id.chars().filter(|c| *c != '-').take(8).collect();
    let base = format!("{stamp}-{short}");

    let mut candidate = format!("{base}.json");
    let mut serial = 2;
    while dir.join(&candidate).exists() {
        candidate = format!("{base}-{serial}.json");
        serial += 1;
    }
    candidate
}

/// 履歴の一覧。**新しい順**（ファイル名が日時始まりなので名前の降順で足りる）。
///
/// ディレクトリが無いのは失敗ではない（1 度もレビューしていないだけ）。
pub fn list(paths: &StorePaths, repository_id: &str) -> Vec<ReviewIndexRow> {
    let dir = paths.review_dir(repository_id);
    let Ok(listing) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut files: Vec<PathBuf> = listing
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file() && path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
        })
        .collect();
    files.sort();
    files.reverse();

    files.iter().map(|path| row(path)).collect()
}

/// 1 件の全文。
pub fn load(paths: &StorePaths, repository_id: &str, file: &str) -> Result<StoredReview, String> {
    let path = resolve(paths, repository_id, file)?;
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("レビュー結果を読めません ({}): {error}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|error| format!("レビュー結果を読めません ({file}): {error}"))
}

/// ファイル名からパスを作る。**ディレクトリを跨がせない。**
///
/// 一覧が返した名前しか来ない前提だが、`..` を含む名前を渡されて
/// `%APPDATA%` の外を読ませる形を残さない。
fn resolve(paths: &StorePaths, repository_id: &str, file: &str) -> Result<PathBuf, String> {
    let bad = file.is_empty()
        || file.contains('/')
        || file.contains('\\')
        || Path::new(file).components().count() != 1;
    if bad {
        return Err(format!("レビュー結果の名前が不正です: {file}"));
    }
    Ok(paths.review_dir(repository_id).join(file))
}

/// 一覧の 1 行を作る。**読めなくても行は返す。**
fn row(path: &Path) -> ReviewIndexRow {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let base = ReviewIndexRow {
        file: name.clone(),
        ..ReviewIndexRow::default()
    };

    let Ok(text) = fs::read_to_string(path) else {
        return ReviewIndexRow {
            unreadable: Some("ファイルを読めませんでした。".to_string()),
            ..base
        };
    };
    let parsed: IndexShape = match serde_json::from_str(&text) {
        Ok(parsed) => parsed,
        Err(error) => {
            return ReviewIndexRow {
                unreadable: Some(format!("JSON として読めませんでした（{error}）。")),
                ..base
            }
        }
    };
    if parsed.schema_version > SCHEMA_VERSION {
        return ReviewIndexRow {
            saved_at: parsed.saved_at,
            unreadable: Some(format!(
                "新しい形式（schemaVersion {}）です。このバージョンでは開けません。",
                parsed.schema_version
            )),
            ..base
        };
    }

    ReviewIndexRow {
        file: name,
        saved_at: parsed.saved_at,
        model: parsed.run.model,
        profile_name: parsed.profile.name,
        source: parsed.run.source,
        files: parsed.run.files.len(),
        findings: parsed
            .run
            .files
            .iter()
            .map(|file| file.text.as_ref().map_or(0, |text| text.findings.len()))
            .sum(),
        failed: parsed.run.failed,
        cancelled: parsed.run.cancelled,
        unreadable: None,
    }
}

/// 一覧に要るところだけを読む形。**本文の文字列は組み立てない。**
#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct IndexShape {
    schema_version: u32,
    saved_at: String,
    profile: ProfileSnapshot,
    run: IndexRun,
}

impl Default for IndexShape {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            saved_at: String::new(),
            profile: ProfileSnapshot::default(),
            run: IndexRun::default(),
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct IndexRun {
    model: String,
    /// **`DiffSource` に「既定」は無い**ので、読めなければ `None` のままにする。
    source: Option<DiffSource>,
    files: Vec<IndexFile>,
    failed: usize,
    cancelled: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct IndexFile {
    text: Option<IndexText>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct IndexText {
    /// 中身は読まない。**数えるだけ。**
    findings: Vec<serde::de::IgnoredAny>,
}

#[cfg(test)]
mod tests {
    use super::{list, load, save, unique_name, ProfileSnapshot};
    use crate::git::diff::DiffSource;
    use crate::llm::review::ReviewRun;
    use crate::store::paths::StorePaths;
    use crate::store::settings::LlmProfile;

    fn profile() -> LlmProfile {
        LlmProfile {
            id: "p1".to_string(),
            name: "ローカル".to_string(),
            model: "qwen2.5-coder:14b".to_string(),
            base_url: "http://localhost:11434/v1".to_string(),
            ..LlmProfile::default()
        }
    }

    fn run(run_id: &str) -> ReviewRun {
        ReviewRun {
            run_id: run_id.to_string(),
            profile_id: "p1".to_string(),
            model: "qwen2.5-coder:14b".to_string(),
            source: DiffSource::WorkingTree { staged: false },
            skills: Vec::new(),
            files: Vec::new(),
            summary: None,
            failed: 0,
            cancelled: false,
            started_at: 0,
            elapsed_ms: 0,
        }
    }

    /// **同じ秒に 2 件でも衝突しない。** `runId` の先頭 8 桁を足してある。
    #[test]
    fn two_reviews_in_the_same_second_get_different_names() {
        let dir = tempfile::tempdir().unwrap();
        let at = chrono::Local::now();
        let first = unique_name(dir.path(), &at, "1a2b3c4d-0000-0000-0000-000000000000");
        let second = unique_name(dir.path(), &at, "9f8e7d6c-0000-0000-0000-000000000000");
        assert_ne!(first, second);
        assert!(first.ends_with(".json"));
    }

    /// **同じ runId で同じ秒でも、既にあるファイルを潰さない。**
    #[test]
    fn an_existing_file_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let at = chrono::Local::now();
        let first = unique_name(dir.path(), &at, "1a2b3c4d");
        std::fs::write(dir.path().join(&first), "{}").unwrap();

        let second = unique_name(dir.path(), &at, "1a2b3c4d");
        assert_ne!(first, second);
        assert!(second.contains("-2."), "{second}");
    }

    /// **base URL は redact を通してから残す**（CLAUDE.md §4）。
    #[test]
    fn the_base_url_never_keeps_credentials() {
        let snapshot = ProfileSnapshot::of(&LlmProfile {
            base_url: "https://tatsu:ghp_secretvalue0123456789@example.invalid/v1".to_string(),
            ..profile()
        });
        assert!(!snapshot.base_url.contains("ghp_secretvalue"), "{snapshot:?}");
        assert!(snapshot.base_url.contains("***"), "{snapshot:?}");
    }

    /// **上書きせず積む**（DESIGN.md §12.4）。
    #[test]
    fn saving_twice_keeps_both() {
        let dir = tempfile::tempdir().unwrap();
        let paths = StorePaths::new(dir.path());

        let first = save(&paths, "repo-1", &profile(), run("aaaaaaaa")).unwrap();
        let second = save(&paths, "repo-1", &profile(), run("bbbbbbbb")).unwrap();
        assert_ne!(first.file, second.file);

        let rows = list(&paths, "repo-1");
        assert_eq!(rows.len(), 2, "2 件とも残ること");
        assert!(rows.iter().all(|row| row.unreadable.is_none()));
        assert_eq!(rows[0].profile_name, "ローカル");
        assert_eq!(rows[0].model, "qwen2.5-coder:14b");
    }

    /// **1 度もレビューしていないリポジトリでも落ちない。**
    #[test]
    fn an_empty_history_is_not_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let paths = StorePaths::new(dir.path());
        assert!(list(&paths, "never-reviewed").is_empty());
    }

    /// **壊れた 1 件で一覧を落とさない。**
    #[test]
    fn a_broken_file_stays_in_the_list_with_a_reason() {
        let dir = tempfile::tempdir().unwrap();
        let paths = StorePaths::new(dir.path());
        save(&paths, "repo-1", &profile(), run("aaaaaaaa")).unwrap();
        std::fs::write(
            paths.review_dir("repo-1").join("20990101T000000-zzzzzzzz.json"),
            "{壊れている",
        )
        .unwrap();

        let rows = list(&paths, "repo-1");
        assert_eq!(rows.len(), 2, "壊れたものも並ぶ");
        assert!(
            rows[0].unreadable.is_some(),
            "読めない理由が付くこと: {rows:?}"
        );
        assert!(rows[1].unreadable.is_none(), "隣を巻き込まないこと");
    }

    /// **将来版は開かずに理由を出す。**
    #[test]
    fn a_future_schema_is_reported_not_guessed() {
        let dir = tempfile::tempdir().unwrap();
        let paths = StorePaths::new(dir.path());
        std::fs::create_dir_all(paths.review_dir("repo-1")).unwrap();
        std::fs::write(
            paths.review_dir("repo-1").join("20990101T000000-ffffffff.json"),
            r#"{"schemaVersion":99,"savedAt":"2099-01-01T00:00:00+09:00"}"#,
        )
        .unwrap();

        let rows = list(&paths, "repo-1");
        assert!(rows[0]
            .unreadable
            .as_deref()
            .is_some_and(|it| it.contains("schemaVersion 99")));
    }

    #[test]
    fn reads_a_saved_review_back() {
        let dir = tempfile::tempdir().unwrap();
        let paths = StorePaths::new(dir.path());
        let saved = save(&paths, "repo-1", &profile(), run("aaaaaaaa")).unwrap();

        let read = load(&paths, "repo-1", &saved.file).unwrap();
        assert_eq!(read, saved, "書いたものがそのまま戻ること");
    }

    /// **`..` でディレクトリの外を読ませない。**
    #[test]
    fn a_name_that_escapes_the_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let paths = StorePaths::new(dir.path());
        for name in ["", "../settings.json", "a/b.json", "a\\b.json", ".."] {
            assert!(load(&paths, "repo-1", name).is_err(), "{name:?}");
        }
    }
}
