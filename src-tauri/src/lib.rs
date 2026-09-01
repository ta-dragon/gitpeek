pub mod commandlog;
pub mod git;
mod redact;
pub mod store;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, RunEvent, State};

use commandlog::{CommandLog, CommandLogEntry, EmittingLog};
use git::detect::GitStatus;
use git::repo::{RepositoryEntry, RepositoryProbe};
use store::settings::{RepositorySettings, Settings};
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
        git::detect::detect(&EmittingLog::new(&handle, &log), &program)
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

/// 今回の起動で使う git。未検出なら PATH の `git` を試す。
fn git_program(state: &AppState) -> String {
    state
        .git_path
        .lock()
        .ok()
        .and_then(|path| path.clone())
        .unwrap_or_else(|| "git".to_string())
}

/// UI から渡ってくるパスの表記ゆれを吸収する。末尾の区切りだけ落とす。
/// `canonicalize` は Windows で `\\?\` 付きの見苦しいパスになるので使わない。
fn normalize_path(path: &str) -> PathBuf {
    let trimmed = path.trim();
    let stripped = trimmed.trim_end_matches(['\\', '/']);
    // `C:\` や `/` のようなルートは削り切らない。
    PathBuf::from(if stripped.is_empty() { trimmed } else { stripped })
}

/// パスがリポジトリかどうかと、その素性を調べる。
#[tauri::command]
async fn probe_repository(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<RepositoryProbe, String> {
    let program = git_program(&state);
    let log = state.log.clone();
    let handle = app.clone();
    let path = normalize_path(&path);

    tauri::async_runtime::spawn_blocking(move || {
        git::repo::probe(&EmittingLog::new(&handle, &log), &program, &path)
    })
    .await
    .map_err(|error| error.to_string())
}

/// フォルダ配下の git リポジトリを探す。git は呼ばない。
#[tauri::command]
async fn scan_repositories(root: String, max_depth: Option<u32>) -> Result<Vec<String>, String> {
    let root = normalize_path(&root);
    let depth = max_depth.map_or(git::repo::DEFAULT_MAX_DEPTH, |depth| depth as usize);

    tauri::async_runtime::spawn_blocking(move || {
        git::repo::scan(&root, depth, git::repo::DEFAULT_EXCLUDED)
            .into_iter()
            .map(|path| path.display().to_string())
            .collect()
    })
    .await
    .map_err(|error| error.to_string())
}

/// リポジトリを登録する。同じパスが登録済みならその登録を返す。
#[tauri::command]
fn add_repository(
    state: State<'_, AppState>,
    path: String,
) -> Result<RepositorySettings, String> {
    state.store.add_repository(&normalize_path(&path))
}

/// 登録を解除する。**フォルダには触らない。**
#[tauri::command]
fn remove_repository(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.store.remove_repository(&id)
}

/// 登録済みリポジトリを素性付きで返す。パスが消えていれば `probe` は `null`。
#[tauri::command]
async fn list_repositories(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<RepositoryEntry>, String> {
    let repositories = state.store.repositories()?;
    let program = git_program(&state);
    let log = state.log.clone();
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let sink = EmittingLog::new(&handle, &log);
        repositories
            .into_iter()
            .map(|settings| {
                let path = PathBuf::from(&settings.path);
                let probe = path
                    .is_dir()
                    .then(|| git::repo::probe(&sink, &program, &path));
                RepositoryEntry { settings, probe }
            })
            .collect()
    })
    .await
    .map_err(|error| error.to_string())
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
            probe_repository,
            scan_repositories,
            add_repository,
            remove_repository,
            list_repositories,
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
