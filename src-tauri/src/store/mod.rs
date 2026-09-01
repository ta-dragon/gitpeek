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

use std::sync::Mutex;

use serde::Serialize;
use tauri::AppHandle;

use paths::StorePaths;
use settings::{LoadError, Settings, SettingsRecovery};
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
