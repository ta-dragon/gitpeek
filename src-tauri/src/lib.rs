mod commandlog;
mod git;
mod redact;
pub mod store;

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, RunEvent, State};

use commandlog::{CommandLog, CommandLogEntry};
use git::detect::GitStatus;
use store::settings::Settings;
use store::state::UiState;
use store::{SettingsPayload, Store};

pub struct AppState {
    /// 全 git 実行の記録。`Arc` なのはブロッキングタスクへ渡すため。
    pub log: Arc<CommandLog>,
    /// 今回の起動で検出した git 実行ファイル。未検出なら `None`。
    /// 手動指定したパスの永続化先は `settings.json` の `git.path`（設定画面は T-25）。
    pub git_path: Mutex<Option<String>>,
    /// `settings.json` / `state.json` の永続化。
    pub store: Store,
}

/// git を検出する。`path` が指定されていればそのフルパスを、無ければ PATH 上の `git` を試す。
#[tauri::command]
async fn detect_git(
    app: AppHandle,
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<GitStatus, String> {
    let program = path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "git".to_string());

    let log = state.log.clone();
    let handle = app.clone();

    // git の起動はブロッキング処理なので UI スレッドを塞がない。
    let status = tauri::async_runtime::spawn_blocking(move || {
        git::detect::detect(&handle, &log, &program)
    })
    .await
    .map_err(|error| error.to_string())?;

    *state.git_path.lock().map_err(|_| "state poisoned")? = if status.usable() {
        Some(status.path.clone())
    } else {
        None
    };

    Ok(status)
}

/// 画面初期化時にこれまでのコマンドログをまとめて取得する。
/// 以降の追加は `command-log` イベントで届く。
#[tauri::command]
fn list_command_log(state: State<'_, AppState>) -> Vec<CommandLogEntry> {
    state.log.entries()
}

/// `settings.json` を読む。壊れていた場合は退避の記録が `recovered` に入る。
#[tauri::command]
fn load_settings(state: State<'_, AppState>) -> Result<SettingsPayload, String> {
    state.store.settings()
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    state.store.save_settings(settings)
}

#[tauri::command]
fn load_ui_state(state: State<'_, AppState>) -> Result<UiState, String> {
    state.store.ui_state()
}

/// 書き込みは 300ms デバウンスされるので、高頻度に呼んでよい。
#[tauri::command]
fn save_ui_state(state: State<'_, AppState>, ui_state: UiState) -> Result<(), String> {
    state.store.save_ui_state(ui_state)
}

/// 設定と状態の置き場所。設定画面から開けるようにするため文字列で返す。
#[tauri::command]
fn app_data_dir(state: State<'_, AppState>) -> Result<String, String> {
    state.store.root()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 起動時に読んでおくことで、フロントが一度も呼ばなくても
            // settings.json / state.json が生成される。
            let store = Store::init(app.handle());
            app.manage(AppState {
                log: Arc::new(CommandLog::default()),
                git_path: Mutex::new(None),
                store,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_git,
            list_command_log,
            load_settings,
            save_settings,
            load_ui_state,
            save_ui_state,
            app_data_dir
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // デバウンス待ちの UI 状態を取りこぼさない。
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<AppState>() {
                state.store.flush_ui_state();
            }
        }
    });
}
