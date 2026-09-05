//! 設定と UI 状態の永続化（`%APPDATA%\com.tatsu.givsoner\`）。
//!
//! - `paths` — ディレクトリレイアウトの解決
//! - `settings` — 手編集を想定した `settings.json`
//! - `state` — アプリが随時上書きする `state.json`
//! - `json` — アトミック書き込み
//!
//! 読み書きのロジックはすべて「パスを引数で受け取る関数」であり `AppHandle` に依存しない。
//! `AppHandle` に触るのはこのファイルの [`Store::init`] と [`paths::StorePaths::from_app`] だけ。

pub mod json;
pub mod paths;
pub mod settings;
pub mod state;

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use tauri::AppHandle;
use uuid::Uuid;

use paths::StorePaths;
use settings::{LlmProfile, LoadError, RepositorySettings, Settings, SettingsRecovery};
use state::{DebouncedWriter, UiState};

/// フロントへ返す設定。退避が起きた場合はその記録を添える。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPayload {
    pub settings: Settings,
    /// 壊れた `settings.json` を退避して既定値で起動したときのみ入る。
    pub recovered: Option<SettingsRecovery>,
}

/// 設定の保持状態。
struct SettingsSlot {
    /// 読めなかった場合はその理由。**この状態では保存もさせない**
    /// （将来版の設定を古いアプリで潰さないため）。
    loaded: Result<Settings, String>,
    recovered: Option<SettingsRecovery>,
}

/// 永続化の入口。`AppState` が 1 つだけ持つ。
pub struct Store {
    /// `Err` はデータディレクトリすら用意できなかった場合。全コマンドが理由付きで失敗する。
    ready: Result<Ready, String>,
}

struct Ready {
    paths: StorePaths,
    settings: Mutex<SettingsSlot>,
    ui_state: Mutex<UiState>,
    writer: DebouncedWriter,
}

impl Store {
    /// 起動時に 1 度だけ呼ぶ。ディレクトリを用意し、両ファイルを読む（無ければ生成する）。
    pub fn init(app: &AppHandle) -> Self {
        Self {
            ready: Self::open(app),
        }
    }

    fn open(app: &AppHandle) -> Result<Ready, String> {
        let paths = StorePaths::from_app(app)?;
        paths.ensure()?;

        let settings = match settings::load(&paths) {
            Ok(loaded) => SettingsSlot {
                loaded: Ok(loaded.settings),
                recovered: loaded.recovered,
            },
            Err(error) => SettingsSlot {
                loaded: Err(match error {
                    LoadError::FutureVersion { .. } => error.message(),
                    LoadError::Io(detail) => detail,
                }),
                recovered: None,
            },
        };

        let ui_state = state::load(&paths);
        let writer = DebouncedWriter::new(paths.state_file(), state::DEBOUNCE);

        Ok(Ready {
            paths,
            settings: Mutex::new(settings),
            ui_state: Mutex::new(ui_state),
            writer,
        })
    }

    fn ready(&self) -> Result<&Ready, String> {
        self.ready.as_ref().map_err(Clone::clone)
    }

    pub fn root(&self) -> Result<String, String> {
        Ok(self.ready()?.paths.root().display().to_string())
    }

    pub fn settings(&self) -> Result<SettingsPayload, String> {
        let ready = self.ready()?;
        let slot = ready.settings.lock().expect("settings poisoned");
        Ok(SettingsPayload {
            settings: slot.loaded.as_ref().map_err(Clone::clone)?.clone(),
            recovered: slot.recovered.clone(),
        })
    }

    pub fn save_settings(&self, incoming: Settings) -> Result<(), String> {
        let ready = self.ready()?;
        let mut slot = ready.settings.lock().expect("settings poisoned");
        // 読めなかった設定を上書きしない。読めない理由をそのまま返す。
        slot.loaded.as_ref().map_err(Clone::clone)?;

        settings::save(&ready.paths, &incoming)?;
        let mut stored = incoming;
        stored.normalize();
        slot.loaded = Ok(stored);
        // 保存できた時点で退避の通知は役目を終える。
        slot.recovered = None;
        Ok(())
    }

    /// 登録済みリポジトリを `order` 順で返す。
    pub fn repositories(&self) -> Result<Vec<RepositorySettings>, String> {
        let payload = self.settings()?;
        let mut repositories = payload.settings.repositories;
        repositories.sort_by_key(|repository| repository.order);
        Ok(repositories)
    }

    /// ID で 1 件引く。登録が消えていればエラー。
    pub fn repository(&self, id: &str) -> Result<RepositorySettings, String> {
        self.repositories()?
            .into_iter()
            .find(|repository| repository.id == id)
            .ok_or_else(|| format!("登録されていないリポジトリです: {id}"))
    }

    /// リポジトリを登録する。
    ///
    /// 既に同じパスが登録されていれば、重複させずにその登録をそのまま返す。
    /// 素性の判定（bare かどうか等）はここではしない。呼び出し側が `probe` を使う。
    pub fn add_repository(&self, path: &Path) -> Result<RepositorySettings, String> {
        let ready = self.ready()?;
        let mut slot = ready.settings.lock().expect("settings poisoned");
        let settings = slot.loaded.as_mut().map_err(|error| error.clone())?;

        if let Some(existing) = settings
            .repositories
            .iter()
            .find(|repository| same_path(&repository.path, path))
        {
            return Ok(existing.clone());
        }

        let order = settings
            .repositories
            .iter()
            .map(|repository| repository.order)
            .max()
            .map_or(0, |max| max.saturating_add(1));
        let added = RepositorySettings::new(Uuid::new_v4().to_string(), path, order);

        settings.repositories.push(added.clone());
        settings::save(&ready.paths, settings)?;
        Ok(added)
    }

    /// 登録を解除する。**フォルダには触らない。**
    pub fn remove_repository(&self, id: &str) -> Result<(), String> {
        let ready = self.ready()?;
        let mut slot = ready.settings.lock().expect("settings poisoned");
        let settings = slot.loaded.as_mut().map_err(|error| error.clone())?;

        settings.repositories.retain(|repository| repository.id != id);
        settings::save(&ready.paths, settings)
    }

    /// LLM プロファイルを保存順のまま返す。
    pub fn llm_profiles(&self) -> Result<Vec<LlmProfile>, String> {
        Ok(self.settings()?.settings.llm_profiles)
    }

    /// ID で 1 件引く。
    pub fn llm_profile(&self, id: &str) -> Result<LlmProfile, String> {
        self.llm_profiles()?
            .into_iter()
            .find(|profile| profile.id == id)
            .ok_or_else(|| format!("接続先の設定が見つかりません: {id}"))
    }

    /// LLM プロファイルを追加・更新して、保存された姿を返す。
    ///
    /// **`id` と `credential_key` を決めるのはここだけ。** フロントから届いた値は
    /// 使わない。参照キーを呼び出し側に選ばせると、別のプロファイルの資格情報を
    /// 指す形が作れてしまう（CLAUDE.md §4）。
    pub fn upsert_llm_profile(&self, incoming: LlmProfile) -> Result<LlmProfile, String> {
        let ready = self.ready()?;
        let mut slot = ready.settings.lock().expect("settings poisoned");
        let settings = slot.loaded.as_mut().map_err(|error| error.clone())?;

        let stored = match settings
            .llm_profiles
            .iter_mut()
            .find(|profile| !incoming.id.is_empty() && profile.id == incoming.id)
        {
            Some(existing) => {
                // 参照キーは採番したときのまま据え置く。名前や URL を変えても
                // 資格情報を追いかけ直さなくて済む。
                let credential_key = existing.credential_key.clone();
                *existing = LlmProfile {
                    credential_key,
                    ..incoming
                };
                existing.clone()
            }
            None => {
                let added = LlmProfile {
                    id: Uuid::new_v4().to_string(),
                    credential_key: crate::secret::new_credential_key(),
                    ..incoming
                };
                settings.llm_profiles.push(added.clone());
                added
            }
        };

        settings::save(&ready.paths, settings)?;
        Ok(stored)
    }

    /// LLM プロファイルを消し、**消したものを返す**。
    ///
    /// 呼び出し側は返ってきた `credential_key` の資格情報も消すこと。
    /// 消し忘れると資格情報マネージャーに孤児が残る。
    pub fn remove_llm_profile(&self, id: &str) -> Result<Option<LlmProfile>, String> {
        let ready = self.ready()?;
        let mut slot = ready.settings.lock().expect("settings poisoned");
        let settings = slot.loaded.as_mut().map_err(|error| error.clone())?;

        let Some(index) = settings
            .llm_profiles
            .iter()
            .position(|profile| profile.id == id)
        else {
            return Ok(None);
        };
        let removed = settings.llm_profiles.remove(index);

        // 消したプロファイルを既定にしていたリポジトリの参照も外す。
        // 残すと「無い接続先」を指したままになる。
        for repository in &mut settings.repositories {
            if repository.default_llm_profile_id.as_deref() == Some(id) {
                repository.default_llm_profile_id = None;
            }
        }

        settings::save(&ready.paths, settings)?;
        Ok(Some(removed))
    }

    /// 内蔵・グローバル skill を使う / 使わない。**キーは skill の名前。**
    pub fn set_skill_use(&self, name: &str, use_skill: bool) -> Result<(), String> {
        self.edit(|settings| {
            settings.skills.use_skill.insert(name.to_string(), use_skill);
        })
    }

    /// 内蔵・グローバル skill の「追加の指示」。**空なら記録ごと落とす**
    /// （手編集する `settings.json` に空文字を積み上げない）。
    pub fn set_skill_extra(&self, name: &str, extra: &str) -> Result<(), String> {
        self.edit(|settings| {
            if extra.trim().is_empty() {
                settings.skills.extra.remove(name);
            } else {
                settings.skills.extra.insert(name.to_string(), extra.to_string());
            }
        })
    }

    /// リポジトリ内 skill を使う / 使わない。
    ///
    /// **`hash` が `Some` なら「その内容を信頼した」という記録**になる。
    /// `None` は使わない指定で、記録ごと落とす（残すと、置き直したファイルが
    /// 前の記録で即座に効いてしまう）。
    pub fn set_repo_skill_use(
        &self,
        repository_id: &str,
        file: &str,
        hash: Option<String>,
    ) -> Result<(), String> {
        self.edit_repository(repository_id, |repository| match hash {
            Some(hash) => {
                repository.repo_skills.hashes.insert(file.to_string(), hash);
            }
            None => {
                repository.repo_skills.hashes.remove(file);
            }
        })
    }

    /// リポジトリ内 skill の「追加の指示」。
    pub fn set_repo_skill_extra(
        &self,
        repository_id: &str,
        file: &str,
        extra: &str,
    ) -> Result<(), String> {
        self.edit_repository(repository_id, |repository| {
            if extra.trim().is_empty() {
                repository.repo_skills.extra.remove(file);
            } else {
                repository
                    .repo_skills
                    .extra
                    .insert(file.to_string(), extra.to_string());
            }
        })
    }

    /// 設定をその場で書き換えて保存する。**読めない設定は上書きしない。**
    fn edit(&self, change: impl FnOnce(&mut Settings)) -> Result<(), String> {
        let ready = self.ready()?;
        let mut slot = ready.settings.lock().expect("settings poisoned");
        let settings = slot.loaded.as_mut().map_err(|error| error.clone())?;
        change(settings);
        settings::save(&ready.paths, settings)
    }

    /// 登録 1 件を書き換えて保存する。
    fn edit_repository(
        &self,
        id: &str,
        change: impl FnOnce(&mut RepositorySettings),
    ) -> Result<(), String> {
        let ready = self.ready()?;
        let mut slot = ready.settings.lock().expect("settings poisoned");
        let settings = slot.loaded.as_mut().map_err(|error| error.clone())?;
        let Some(repository) = settings
            .repositories
            .iter_mut()
            .find(|repository| repository.id == id)
        else {
            return Err(format!("登録されていないリポジトリです: {id}"));
        };
        change(repository);
        settings::save(&ready.paths, settings)
    }

    /// データディレクトリのレイアウト。グローバル skill の置き場所を引くのに使う。
    pub fn paths(&self) -> Result<&StorePaths, String> {
        Ok(&self.ready()?.paths)
    }

    pub fn ui_state(&self) -> Result<UiState, String> {
        let ready = self.ready()?;
        Ok(ready.ui_state.lock().expect("ui state poisoned").clone())
    }

    /// 書き込みは 300ms デバウンスされる。呼び出しは即座に返る。
    pub fn save_ui_state(&self, incoming: UiState) -> Result<(), String> {
        let ready = self.ready()?;
        *ready.ui_state.lock().expect("ui state poisoned") = incoming.clone();
        ready.writer.schedule(incoming);
        Ok(())
    }

    /// アプリ終了時に呼び、デバウンス待ちの書き込みを取りこぼさない。
    pub fn flush_ui_state(&self) {
        if let Ok(ready) = &self.ready {
            let _ = ready.writer.flush();
        }
    }
}

/// 同じフォルダを指しているか。Windows のパスは大文字小文字を区別しない。
fn same_path(registered: &str, path: &Path) -> bool {
    let candidate = path.display().to_string();
    if cfg!(windows) {
        registered.eq_ignore_ascii_case(&candidate)
    } else {
        registered == candidate
    }
}
