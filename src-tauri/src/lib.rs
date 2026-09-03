pub mod commandlog;
pub mod encoding;
pub mod git;
pub mod graph;
pub mod model;
mod redact;
pub mod store;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State};

use commandlog::{CommandLog, CommandLogEntry, EmittingLog};
use git::detect::GitStatus;
use encoding::TextEncoding;
use git::diff::{CommitDetail, DiffOptions, DiffTarget, FileChange, FileDiff};
use git::status::{WorkingFile, WorkingTree};
use git::progress::{LoadPhase, LoadProgress, ProgressSink, Reporting};
use git::repo::{RepositoryEntry, RepositoryProbe};
use git::snapshot::SnapshotCache;
use graph::reach::BranchStatus;
use graph::{GraphOrder, LaneLayout};
use model::RepositorySnapshot;

/// 読み込みの途中経過をフロントへ送るイベント名。
const SNAPSHOT_PROGRESS_EVENT: &str = "snapshot-progress";

/// 途中経過に**どのリポジトリのものか**を添えて送る。
///
/// 読み込み中に別のリポジトリへ切り替えると、前の読み込みの進捗が後から届く。
/// ID が無いと、切替後の画面に前のリポジトリの件数が出てしまう。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    repository_id: &'a str,
    #[serde(flatten)]
    progress: LoadProgress,
}

/// 途中経過を webview へ流す [`ProgressSink`]。
///
/// git 側のコードを `AppHandle` に依存させないため、Tauri に触るのはここだけ
/// （`commandlog::EmittingLog` と同じ形）。
struct EmittingProgress<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    repository_id: &'a str,
}

impl<R: Runtime> ProgressSink for EmittingProgress<'_, R> {
    fn report(&self, progress: LoadProgress) {
        let _ = self.app.emit(
            SNAPSHOT_PROGRESS_EVENT,
            ProgressEvent {
                repository_id: self.repository_id,
                progress,
            },
        );
    }
}
use store::settings::{RepositorySettings, Settings, VisibleRefs};
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
    /// 直近に読んだグラフ素材。リポジトリ切替を体感即時にする（docs/DESIGN.md §6.2）。
    pub snapshots: Arc<SnapshotCache>,
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
    state.store.remove_repository(&id)?;
    // 同じ ID が再発番されることは無いが、メモリを抱えたままにしない。
    state.snapshots.forget(&id);
    Ok(())
}

/// 全コミットのメタ情報と ref 一覧をまとめて読む（docs/DESIGN.md §4.1）。
///
/// ref の指紋が前回と同じならキャッシュを返し、`git log` を省く。
/// `force` は fetch や checkout の直後に立てる（T-17 / T-18）。
///
/// `estimated_commits` は**前回の読み込み件数**。割合表示の分母に使うだけで、
/// 取得内容には影響しない。初回は `None`（件数だけ出す）。
#[tauri::command]
async fn load_repository_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
    repository_id: String,
    force: bool,
    estimated_commits: Option<u64>,
) -> Result<Arc<RepositorySnapshot>, String> {
    let repository = state.store.repository(&repository_id)?;
    let program = git_program(&state);
    let log = state.log.clone();
    let cache = state.snapshots.clone();
    let handle = app.clone();
    let started = std::time::Instant::now();

    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&repository.path);
        if !path.is_dir() {
            return Err(format!("フォルダが見つかりません: {}", path.display()));
        }
        git::snapshot::load_cached(
            &EmittingLog::new(&handle, &log),
            &program,
            &path,
            &cache,
            &repository.id,
            force,
            &Reporting::new(
                &EmittingProgress {
                    app: &handle,
                    repository_id: &repository.id,
                },
                estimated_commits,
            ),
        )
    })
    .await
    .map_err(|error| error.to_string())??;

    // 直列化と転送はこのあと。100 万コミットでは 450MB になり数秒かかるので、
    // 「100% のまま無言」にならないよう最後の段階を伝えてから返す。
    let _ = app.emit(
        SNAPSHOT_PROGRESS_EVENT,
        ProgressEvent {
            repository_id: &repository_id,
            progress: LoadProgress {
                phase: LoadPhase::Transfer,
                commits: snapshot.commits.len() as u64,
                estimated_total: estimated_commits,
                elapsed_ms: started.elapsed().as_millis() as u64,
            },
        },
    );

    Ok(snapshot)
}

/// 描画用のレーンを確定する（docs/DESIGN.md §5.1 / CLAUDE.md §3）。
///
/// コミットは [`git::snapshot::load_cached`] から取る。ref の指紋が変わっていなければ
/// `for-each-ref` 1 回で返るので、**レーンのために別経路で `git log` を呼ばない**。
/// 並び順の切替も `git log` を再実行せず、メモリ上で並べ替えるだけ（§4.3）。
///
/// `visible_refs` で絞ると到達可能集合を計算し直して行と線が実際に減る（§4.4）。
#[tauri::command]
async fn compute_lane_layout(
    app: AppHandle,
    state: State<'_, AppState>,
    repository_id: String,
    visible_refs: VisibleRefs,
    order: GraphOrder,
) -> Result<LaneLayout, String> {
    let repository = state.store.repository(&repository_id)?;
    let program = git_program(&state);
    let log = state.log.clone();
    let cache = state.snapshots.clone();
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&repository.path);
        if !path.is_dir() {
            return Err(format!("フォルダが見つかりません: {}", path.display()));
        }
        let snapshot = git::snapshot::load_cached(
            &EmittingLog::new(&handle, &log),
            &program,
            &path,
            &cache,
            &repository.id,
            false,
            &Reporting::silent(),
        )?;
        Ok(graph::layout(&snapshot, &visible_refs, order))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 上流を持つローカルブランチの ahead/behind（docs/DESIGN.md §4.5）。
///
/// **`git rev-list --count` は呼ばない。** ブランチ数だけプロセスを起動することになるので、
/// 既に手元にあるコミットの親子関係から数える（CLAUDE.md §2）。
/// 可視 ref には依らない（隠したブランチの ahead/behind も出す）。
#[tauri::command]
async fn compute_branch_status(
    app: AppHandle,
    state: State<'_, AppState>,
    repository_id: String,
) -> Result<Vec<BranchStatus>, String> {
    let repository = state.store.repository(&repository_id)?;
    let program = git_program(&state);
    let log = state.log.clone();
    let cache = state.snapshots.clone();
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&repository.path);
        if !path.is_dir() {
            return Err(format!("フォルダが見つかりません: {}", path.display()));
        }
        let snapshot = git::snapshot::load_cached(
            &EmittingLog::new(&handle, &log),
            &program,
            &path,
            &cache,
            &repository.id,
            false,
            &Reporting::silent(),
        )?;
        Ok(graph::reach::all_branch_status(&snapshot))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// コミット 1 件の本文（docs/DESIGN.md §7.3）。
///
/// 一覧に載っているメタ情報と重なるが、**コミッターと本文はここでしか取れない**。
/// スナップショットに全コミットの本文まで載せると、数万コミットで数百 MB になる。
#[tauri::command]
async fn load_commit_detail(
    app: AppHandle,
    state: State<'_, AppState>,
    repository_id: String,
    sha: String,
) -> Result<CommitDetail, String> {
    let repository = state.store.repository(&repository_id)?;
    let program = git_program(&state);
    let log = state.log.clone();
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&repository.path);
        if !path.is_dir() {
            return Err(format!("フォルダが見つかりません: {}", path.display()));
        }
        git::diff::commit_detail(&EmittingLog::new(&handle, &log), &program, &path, &sha)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 変更ファイル一覧（docs/DESIGN.md §7.3）。
///
/// **`parent` はフロントが決める。** マージコミットは差分が一意に決まらないので
/// 既定を第 1 親にし、ドロップダウンで切り替えられるようにしてある（§7.4）。
/// `None` はルートコミット（空ツリーとの差分）を意味する。
#[tauri::command]
async fn load_changed_files(
    app: AppHandle,
    state: State<'_, AppState>,
    repository_id: String,
    sha: String,
    parent: Option<String>,
    // `A...B`（マージベース起点）で比べる。2 点比較のときだけ意味を持つ。
    symmetric: bool,
) -> Result<Vec<FileChange>, String> {
    let repository = state.store.repository(&repository_id)?;
    let program = git_program(&state);
    let log = state.log.clone();
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&repository.path);
        if !path.is_dir() {
            return Err(format!("フォルダが見つかりません: {}", path.display()));
        }
        git::diff::changed_files(
            &EmittingLog::new(&handle, &log),
            &program,
            &path,
            git::diff::Revisions::Range {
                from: parent.as_deref(),
                to: &sha,
                symmetric,
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 作業ツリーの状態（docs/DESIGN.md §7.5）。
///
/// **read-only。** stage / unstage / discard / stash を提供する経路は無い（CLAUDE.md §1）。
#[tauri::command]
async fn load_working_tree(
    app: AppHandle,
    state: State<'_, AppState>,
    repository_id: String,
) -> Result<WorkingTree, String> {
    let repository = state.store.repository(&repository_id)?;
    let program = git_program(&state);
    let log = state.log.clone();
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&repository.path);
        if !path.is_dir() {
            return Err(format!("フォルダが見つかりません: {}", path.display()));
        }
        git::status::working_tree(&EmittingLog::new(&handle, &log), &program, &path)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 未追跡ファイルの全文（docs/DESIGN.md §7.5）。
///
/// **差分にはしない。** 全行追加の差分は視覚的ノイズが大きすぎる。
#[tauri::command]
async fn load_working_file(
    state: State<'_, AppState>,
    repository_id: String,
    path: String,
) -> Result<WorkingFile, String> {
    let repository = state.store.repository(&repository_id)?;

    tauri::async_runtime::spawn_blocking(move || {
        git::status::read_working_file(&PathBuf::from(&repository.path), &path)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 差分の出どころ。フロントの `DiffScope` と同じ形（`kind` で分かれる）。
///
/// **真偽値を並べるのではなく種類で分ける。** `parent` / `sha` / `symmetric` /
/// 「作業ツリーか」を平らに並べると、成り立たない組み合わせが表現できてしまう。
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum DiffSource {
    /// リビジョン 2 点。`parent` が `None` はルートコミット。
    Range {
        parent: Option<String>,
        sha: String,
        symmetric: bool,
    },
    /// 作業ツリー。`staged` なら HEAD と index、そうでなければ index と作業ツリー。
    WorkingTree { staged: bool },
}

impl DiffSource {
    fn revisions(&self) -> git::diff::Revisions<'_> {
        match self {
            Self::Range {
                parent,
                sha,
                symmetric,
            } => git::diff::Revisions::Range {
                from: parent.as_deref(),
                to: sha,
                symmetric: *symmetric,
            },
            Self::WorkingTree { staged } => git::diff::Revisions::WorkingTree { staged: *staged },
        }
    }
}

/// ファイル 1 つ分の差分（docs/DESIGN.md §7.2, §9）。
///
/// **`old_path` はリネームのときに必ず渡す。** pathspec に新しいパスだけを渡すと、
/// git は対になる側が見えずリネームを検出できず、全行が追加された新規ファイルとして出る。
///
/// `forced_encoding` は画面からの手動上書き。`None` なら自動判別（§9.1）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn load_file_diff(
    app: AppHandle,
    state: State<'_, AppState>,
    repository_id: String,
    source: DiffSource,
    path: String,
    old_path: Option<String>,
    context_lines: u32,
    ignore_whitespace: bool,
    forced_encoding: Option<TextEncoding>,
) -> Result<FileDiff, String> {
    let repository = state.store.repository(&repository_id)?;
    let program = git_program(&state);
    let log = state.log.clone();
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let repo_path = PathBuf::from(&repository.path);
        if !repo_path.is_dir() {
            return Err(format!("フォルダが見つかりません: {}", repo_path.display()));
        }
        git::diff::file_diff(
            &EmittingLog::new(&handle, &log),
            &program,
            &repo_path,
            &DiffTarget {
                revisions: source.revisions(),
                path: &path,
                old_path: old_path.as_deref(),
            },
            &DiffOptions {
                context_lines,
                ignore_whitespace,
                encoding: forced_encoding,
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
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
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 起動時に読んでおくことで、フロントが一度も呼ばなくても
            // settings.json / state.json が生成される。
            let store = Store::init(app.handle());
            app.manage(AppState {
                log: Arc::new(CommandLog::default()),
                git_path: Mutex::new(None),
                store,
                snapshots: Arc::new(SnapshotCache::new()),
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
            load_repository_snapshot,
            compute_lane_layout,
            compute_branch_status,
            load_commit_detail,
            load_changed_files,
            load_file_diff,
            load_working_tree,
            load_working_file,
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
