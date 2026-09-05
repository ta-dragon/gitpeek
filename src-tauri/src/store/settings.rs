//! `settings.json` の型と読み書き。
//!
//! **手編集を想定した唯一のファイル**（docs/DESIGN.md §12.2）。そのため
//!
//! - 壊れていても黙って捨てず `settings.json.bak` へ退避してから既定値で再生成する
//! - キーが欠けていても既定値で補って読む（欠落は破損ではない）
//! - `schemaVersion` が将来版なら読まずにエラーを返す。古いアプリで新しい設定を潰さない
//!
//! **API キーをここに書いてはいけない。** `LlmProfile` が持つのは Windows 資格情報
//! マネージャーの参照キーだけ（CLAUDE.md §4）。

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::redact::redact;
use crate::store::json;
use crate::store::paths::StorePaths;

/// `settings.json` / `state.json` 共通のスキーマ版。
pub const SCHEMA_VERSION: u32 = 1;

/// AI レビューの並列度の上限（CLAUDE.md §7）。
pub const MAX_REVIEW_CONCURRENCY: u8 = 3;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// 必須。欠けている設定ファイルは破損として扱う（CLAUDE.md §5）。
    pub schema_version: u32,
    #[serde(default)]
    pub git: GitSettings,
    #[serde(default)]
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub repositories: Vec<RepositorySettings>,
    #[serde(default)]
    pub llm_profiles: Vec<LlmProfile>,
    #[serde(default)]
    pub ui: UiSettings,
    #[serde(default)]
    pub fetch: FetchSettings,
    #[serde(default)]
    pub review: ReviewSettings,
    /// 内蔵とグローバル skill の使い方（T-21）。
    #[serde(default)]
    pub skills: SkillSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            git: GitSettings::default(),
            workspace_root: None,
            repositories: Vec::new(),
            llm_profiles: Vec::new(),
            ui: UiSettings::default(),
            fetch: FetchSettings::default(),
            review: ReviewSettings::default(),
            skills: SkillSettings::default(),
        }
    }
}

impl Settings {
    /// 手編集で入りうる範囲外の値を既定へ寄せる。
    /// 値ひとつの打ち間違いでファイル全体を退避してしまわないための緩衝。
    pub fn normalize(&mut self) {
        self.schema_version = SCHEMA_VERSION;
        clamp_choice(&mut self.ui.theme, &["system", "light", "dark"]);
        clamp_choice(&mut self.ui.date_format, &["relative", "absolute"]);
        clamp_choice(&mut self.ui.diff_layout, &["side-by-side", "unified"]);
        clamp_choice(&mut self.ui.commit_order, &["topo", "date"]);
        for repository in &mut self.repositories {
            clamp_choice(&mut repository.visible_refs.mode, &["all", "custom"]);
        }
        self.review.concurrency = self.review.concurrency.clamp(1, MAX_REVIEW_CONCURRENCY);
    }
}

/// 候補に無い値なら先頭（＝既定）へ戻す。
fn clamp_choice(value: &mut String, allowed: &[&str]) {
    if !allowed.contains(&value.as_str()) {
        value.clear();
        value.push_str(allowed[0]);
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GitSettings {
    /// PATH 上に git が無い場合のフルパス。既定は `None`（PATH の `git` を使う）。
    pub path: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RepositorySettings {
    pub id: String,
    pub name: String,
    pub path: String,
    pub order: u32,
    pub visible_refs: VisibleRefs,
    pub default_llm_profile_id: Option<String>,
    pub repo_skills: RepoSkillTrust,
}

impl RepositorySettings {
    /// 登録時の既定値。名前はディレクトリ名、可視 ref は全件、skill は未信頼。
    pub fn new(id: String, path: &Path, order: u32) -> Self {
        Self {
            id,
            name: display_name(path),
            path: path.display().to_string(),
            order,
            ..Self::default()
        }
    }
}

/// 一覧に出す既定の名前。末尾のディレクトリ名を使い、取れなければパスそのもの。
/// bare の `foo.git` は `foo` と呼ぶ方が一覧で見分けやすい。
fn display_name(path: &Path) -> String {
    let Some(name) = path.file_name().map(|name| name.to_string_lossy().into_owned()) else {
        return path.display().to_string();
    };
    match name.strip_suffix(".git") {
        Some(stem) if !stem.is_empty() => stem.to_string(),
        _ => name,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VisibleRefs {
    /// `"all"` | `"custom"`
    pub mode: String,
    pub excluded: Vec<String>,
}

impl Default for VisibleRefs {
    fn default() -> Self {
        Self {
            mode: "all".to_string(),
            excluded: Vec::new(),
        }
    }
}

/// リポジトリ内 skill の**ファイルごとの**信頼（T-21。CLAUDE.md §4）。
///
/// **記録があること＝そのファイルを使うこと。** 記録に無いファイルは未信頼なので、
/// 「あとから増えたファイル」は特別扱いを足さなくても自動的に未信頼になる。
/// 記録したハッシュと内容が食い違えば、**そのファイルだけ**が未信頼へ戻る。
///
/// もともとはリポジトリ単位の `trusted: bool` だったが、2026-09-05 に利用者の判断で
/// ファイル単位へ絞った（DESIGN.md §11.2.1）。**緩めたのではなく絞ったので**、
/// 古い `trusted: true` ＋ `hashes` はそのまま「この一覧を使う」と読める。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RepoSkillTrust {
    /// ファイル名 → 使うと決めたときの内容の SHA-256。
    pub hashes: BTreeMap<String, String>,
    /// ファイル名 → 本文の後ろへ足す一言。**skill ファイルは書き換えない。**
    pub extra: BTreeMap<String, String>,
}

/// 内蔵とグローバル skill の使い方（T-21）。**キーは skill の名前。**
///
/// リポジトリ内 skill は [`RepoSkillTrust`] が持つ（あちらは信頼が絡むのでファイル名が鍵）。
///
/// **手編集を想定して、素直な 2 つの表にしてある**（DESIGN.md §12.2）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SkillSettings {
    /// skill 名 → 使うかどうか。**記録が無ければ skill ファイルの `enabled` に従う。**
    pub use_skill: BTreeMap<String, bool>,
    /// skill 名 → 本文の後ろへ足す一言。
    pub extra: BTreeMap<String, String>,
}

/// T-20 で中身を使う。**`api_key` フィールドを作ってはいけない**（CLAUDE.md §4）。
/// 実際のキーは Windows 資格情報マネージャーにあり、ここには参照キーだけを置く。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LlmProfile {
    pub id: String,
    pub name: String,
    /// OpenAI 互換のベース URL。Ollama も `http://localhost:11434/v1` で扱う。
    pub base_url: String,
    pub model: String,
    pub context_window: u32,
    pub temperature: f32,
    pub max_tokens: u32,
    /// 資格情報マネージャーの参照キー（例 `givsoner/llm/<id>`）。
    pub credential_key: String,
}

impl Default for LlmProfile {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            base_url: String::new(),
            model: String::new(),
            context_window: 32768,
            temperature: 0.2,
            max_tokens: 4096,
            credential_key: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UiSettings {
    /// `"system"` | `"light"` | `"dark"`。既定は OS 追従（docs/DESIGN.md §6.1）。
    pub theme: String,
    /// `"relative"` | `"absolute"`
    pub date_format: String,
    /// `"side-by-side"` | `"unified"`
    pub diff_layout: String,
    /// `-U<N>`。**`u8` にしないこと** — 画面の「すべて」は十分大きな `-U` で
    /// 代用しており（`ALL_CONTEXT_LINES` = 1000000）、`u8` だと保存が弾かれる。
    pub context_lines: u32,
    pub ignore_whitespace: bool,
    pub show_line_endings: bool,
    /// `"topo"` | `"date"`
    pub commit_order: String,
    /// 差分をこの行数より多く含むファイルは既定で折りたたむ（docs/DESIGN.md §7.2）。
    pub collapse_lines: u32,
    /// 同じくバイト数。どちらか一方でも超えたら折りたたむ。
    pub collapse_bytes: u32,
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            date_format: "relative".to_string(),
            diff_layout: "side-by-side".to_string(),
            context_lines: 3,
            ignore_whitespace: false,
            show_line_endings: false,
            commit_order: "topo".to_string(),
            collapse_lines: 3_000,
            collapse_bytes: 500 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FetchSettings {
    pub stale_warning_days: u32,
}

impl Default for FetchSettings {
    fn default() -> Self {
        Self {
            stale_warning_days: 7,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReviewSettings {
    /// 既定は逐次。上限 3（CLAUDE.md §7）。
    pub concurrency: u8,
    /// LLM へ渡す unified diff の文脈行数。
    pub context_lines: u8,
}

impl Default for ReviewSettings {
    fn default() -> Self {
        Self {
            concurrency: 1,
            context_lines: 10,
        }
    }
}

/// 壊れた `settings.json` を退避したときの記録。フロントへそのまま通知する。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsRecovery {
    pub backup_path: String,
    /// 人間向けの理由。念のため秘匿情報をマスクしてから渡す（CLAUDE.md §4）。
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadedSettings {
    pub settings: Settings,
    /// 退避と再生成が起きた場合のみ `Some`。
    pub recovered: Option<SettingsRecovery>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LoadError {
    /// 将来版の設定。読まず・触らずにエラーを返す。
    FutureVersion { found: u32, supported: u32 },
    /// 読めない（権限など）。破損とは区別し、退避も再生成もしない。
    Io(String),
}

impl LoadError {
    pub fn message(&self) -> String {
        match self {
            Self::FutureVersion { found, supported } => format!(
                "settings.json のスキーマ版 {found} はこのバージョンの Givsoner（対応 {supported}）では読めません。アプリを更新してください。設定は書き換えていません。"
            ),
            Self::Io(detail) => detail.clone(),
        }
    }
}

/// `settings.json` を読む。無ければ既定値を書き出して返す。
pub fn load(paths: &StorePaths) -> Result<LoadedSettings, LoadError> {
    let file = paths.settings_file();

    let raw = match fs::read_to_string(&file) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let settings = Settings::default();
            save(paths, &settings).map_err(LoadError::Io)?;
            return Ok(LoadedSettings {
                settings,
                recovered: None,
            });
        }
        Err(error) => {
            return Err(LoadError::Io(format!(
                "設定を読み込めません ({}): {error}",
                file.display()
            )))
        }
    };

    // まず Value として読み、schemaVersion だけを先に見る。
    // 将来版を Settings へデシリアライズすると、知らないキーを落として書き戻す危険がある。
    let value = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(value) => value,
        Err(error) => return recover(paths, &raw, &format!("JSON として読めません: {error}")),
    };

    let Some(found) = value.get("schemaVersion").and_then(serde_json::Value::as_u64) else {
        return recover(paths, &raw, "schemaVersion がありません");
    };
    let found = found.min(u64::from(u32::MAX)) as u32;
    if found > SCHEMA_VERSION {
        return Err(LoadError::FutureVersion {
            found,
            supported: SCHEMA_VERSION,
        });
    }

    // found < SCHEMA_VERSION のマイグレーションはここに足す。v1 のみなので現状は何もしない。
    let mut settings = match serde_json::from_value::<Settings>(value) {
        Ok(settings) => settings,
        Err(error) => return recover(paths, &raw, &format!("設定の形が想定と違います: {error}")),
    };
    settings.normalize();

    Ok(LoadedSettings {
        settings,
        recovered: None,
    })
}

/// 壊れた設定を退避し、既定値で再生成する。
fn recover(paths: &StorePaths, raw: &str, reason: &str) -> Result<LoadedSettings, LoadError> {
    let backup = paths.settings_backup_file();
    json::write_atomic(&backup, raw).map_err(LoadError::Io)?;

    let settings = Settings::default();
    save(paths, &settings).map_err(LoadError::Io)?;

    Ok(LoadedSettings {
        settings,
        recovered: Some(SettingsRecovery {
            backup_path: backup.display().to_string(),
            reason: redact(reason),
        }),
    })
}

/// `settings.json` をアトミックに書く。
pub fn save(paths: &StorePaths, settings: &Settings) -> Result<(), String> {
    let mut settings = settings.clone();
    settings.normalize();
    json::write_pretty(&paths.settings_file(), &settings)
}

#[cfg(test)]
mod tests {
    use super::{load, save, LoadError, LoadedSettings, Settings, UiSettings, SCHEMA_VERSION};
    use crate::store::paths::StorePaths;

    fn temp_paths() -> (tempfile::TempDir, StorePaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = StorePaths::new(dir.path());
        paths.ensure().unwrap();
        (dir, paths)
    }

    #[test]
    fn creates_defaults_when_missing() {
        let (_dir, paths) = temp_paths();

        let loaded = load(&paths).unwrap();
        assert_eq!(loaded.recovered, None);
        assert_eq!(loaded.settings, Settings::default());
        assert_eq!(loaded.settings.schema_version, SCHEMA_VERSION);
        assert_eq!(loaded.settings.ui.theme, "system");
        assert_eq!(loaded.settings.review.concurrency, 1);
        assert!(paths.settings_file().is_file());

        // 書き出したものをそのまま読み戻せる。
        let again = load(&paths).unwrap();
        assert_eq!(again.settings, loaded.settings);
    }

    #[test]
    fn round_trips_saved_settings() {
        let (_dir, paths) = temp_paths();

        let mut settings = Settings::default();
        settings.ui.theme = "dark".to_string();
        settings.workspace_root = Some("C:\\Users\\tatsu\\Gitwork".to_string());
        settings.fetch.stale_warning_days = 14;
        save(&paths, &settings).unwrap();

        let loaded = load(&paths).unwrap();
        assert_eq!(loaded.settings, settings);
        assert_eq!(loaded.recovered, None);
    }

    #[test]
    fn keeps_defaults_for_missing_keys() {
        let (_dir, paths) = temp_paths();
        std::fs::write(
            paths.settings_file(),
            r#"{ "schemaVersion": 1, "ui": { "theme": "dark" } }"#,
        )
        .unwrap();

        let loaded = load(&paths).unwrap();
        assert_eq!(loaded.recovered, None, "キーの欠落は破損ではない");
        assert_eq!(loaded.settings.ui.theme, "dark");
        assert_eq!(loaded.settings.ui.context_lines, 3);
        assert_eq!(loaded.settings.fetch.stale_warning_days, 7);
    }

    #[test]
    fn backs_up_broken_json_and_regenerates() {
        let (_dir, paths) = temp_paths();
        let broken = "{ this is not json";
        std::fs::write(paths.settings_file(), broken).unwrap();

        let LoadedSettings {
            settings,
            recovered,
        } = load(&paths).unwrap();
        let recovered = recovered.expect("退避が報告されること");

        assert_eq!(settings, Settings::default());
        assert_eq!(
            std::fs::read_to_string(paths.settings_backup_file()).unwrap(),
            broken,
            "壊れた内容をそのまま .bak へ退避する"
        );
        assert_eq!(
            recovered.backup_path,
            paths.settings_backup_file().display().to_string()
        );
        assert!(paths.settings_file().is_file());
        assert!(
            load(&paths).unwrap().recovered.is_none(),
            "再生成後は正常に読める"
        );
    }

    #[test]
    fn backs_up_when_schema_version_is_missing() {
        let (_dir, paths) = temp_paths();
        std::fs::write(paths.settings_file(), r#"{ "ui": { "theme": "dark" } }"#).unwrap();

        let loaded = load(&paths).unwrap();
        assert!(loaded.recovered.is_some());
        assert_eq!(loaded.settings.ui.theme, "system");
    }

    #[test]
    fn refuses_future_schema_version_without_touching_the_file() {
        let (_dir, paths) = temp_paths();
        let future = r#"{ "schemaVersion": 99, "ui": { "theme": "dark" } }"#;
        std::fs::write(paths.settings_file(), future).unwrap();

        let error = load(&paths).unwrap_err();
        assert_eq!(
            error,
            LoadError::FutureVersion {
                found: 99,
                supported: SCHEMA_VERSION,
            }
        );
        assert!(error.message().contains("99"));
        assert_eq!(
            std::fs::read_to_string(paths.settings_file()).unwrap(),
            future,
            "将来版の設定を書き換えてはいけない"
        );
        assert!(!paths.settings_backup_file().exists(), "退避もしない");
    }

    #[test]
    fn normalizes_out_of_range_values() {
        let (_dir, paths) = temp_paths();
        std::fs::write(
            paths.settings_file(),
            r#"{ "schemaVersion": 1, "ui": { "theme": "solarized", "commitOrder": "" },
                 "review": { "concurrency": 9 } }"#,
        )
        .unwrap();

        let loaded = load(&paths).unwrap();
        assert_eq!(loaded.recovered, None, "値の打ち間違いでファイルを捨てない");
        assert_eq!(loaded.settings.ui.theme, "system");
        assert_eq!(loaded.settings.ui.commit_order, "topo");
        assert_eq!(loaded.settings.review.concurrency, 3, "並列度は 3 が上限");
    }

    #[test]
    fn never_writes_an_api_key_field() {
        let (_dir, paths) = temp_paths();
        let mut settings = Settings::default();
        settings.llm_profiles.push(super::LlmProfile {
            id: "p1".to_string(),
            name: "local-qwen".to_string(),
            base_url: "http://localhost:11434/v1".to_string(),
            model: "qwen2.5-coder:14b".to_string(),
            credential_key: "givsoner/llm/p1".to_string(),
            ..Default::default()
        });
        save(&paths, &settings).unwrap();

        let text = std::fs::read_to_string(paths.settings_file()).unwrap();
        assert!(text.contains("credentialKey"));
        assert!(!text.contains("apiKey"), "{text}");
        assert!(!text.contains("api_key"), "{text}");
    }
    /// **「すべて」の `-U` が設定に収まること。**
    ///
    /// `context_lines` を `u8` にしていたときは、画面で「すべて」を選ぶと
    /// 保存が丸ごと弾かれた（値は `ALL_CONTEXT_LINES` = 1000000）。
    #[test]
    fn context_lines_holds_the_all_choice() {
        let ui: UiSettings =
            serde_json::from_str(r#"{"contextLines":1000000}"#).expect("読めるはず");
        assert_eq!(ui.context_lines, 1_000_000);
        // 他の既定値まで消えていないこと（`serde(default)` が効いている）。
        assert_eq!(ui.collapse_lines, 3_000);
    }
}
