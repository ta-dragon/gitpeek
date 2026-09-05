pub mod commandlog;
pub mod encoding;
pub mod git;
pub mod graph;
pub mod llm;
pub mod model;
mod redact;
pub mod secret;
pub mod store;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State};

use commandlog::{CommandLog, CommandLogEntry, EmittingLog};
use git::detect::GitStatus;
use encoding::TextEncoding;
use git::diff::{CommitDetail, DiffOptions, DiffTarget, FileChange, FileDiff};
use git::ops::FetchOutcome;
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
    /// 実行中の fetch を止めるための合図。実行していなければ `None`。
    ///
    /// **一括 fetch はフロントが 1 件ずつ呼ぶ**ので、ここで止められるのは
    /// 「いま走っている 1 件」だけ。次のリポジトリへ進まないようにするのは
    /// フロント側の責務（docs/DESIGN.md §8.3）。
    pub fetch_cancel: Mutex<Option<git::exec::Cancel>>,
    /// 実行中の clone を止めるための合図。実行していなければ `None`。
    ///
    /// **fetch と別に持つ。** 同じ枠を使い回すと、clone の最中に fetch を始めた
    /// 瞬間に clone 側の合図が捨てられ、中止ボタンが効かなくなる。
    pub clone_cancel: Mutex<Option<git::exec::Cancel>>,
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

/// いまの時刻を Unix ミリ秒で。放置警告の判定にだけ使う。
fn now_ms() -> i64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(since) => since.as_millis() as i64,
        Err(error) => -(error.duration().as_millis() as i64),
    }
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


/// checkout / FF マージを走らせてよいか（docs/DESIGN.md §8.1）。
///
/// **判定は `git::ops::preflight` の 1 箇所だけ。** ここは材料を集めて渡すだけで、
/// フロントで条件を組み直さないこと（起動点が 4 つあるので必ず食い違う）。
///
/// probe と `status` で git を何回か起動するが、**これは書き込みの直前にしか走らない**。
#[tauri::command]
async fn preflight_write(
    app: AppHandle,
    state: State<'_, AppState>,
    repository_id: String,
) -> Result<git::ops::WriteGuard, String> {
    let repository = state.store.repository(&repository_id)?;
    let program = git_program(&state);
    let log = state.log.clone();
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&repository.path);
        if !path.is_dir() {
            return Err(format!("フォルダが見つかりません: {}", path.display()));
        }
        Ok(guard_for(&EmittingLog::new(&handle, &log), &program, &path))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 判定の材料を集める。**`preflight_write` と実行コマンドの両方がこれを通る。**
///
/// ダイアログを開いた時点と実行の瞬間で状態は変わりうるので、**表示用に 1 回、
/// 実行の直前にもう 1 回**同じ関数を通す。判定するコードは 1 つのまま。
fn guard_for(log: &dyn commandlog::LogSink, program: &str, path: &Path) -> git::ops::WriteGuard {
    let probe = git::repo::probe(log, program, path);
    let unborn = matches!(probe.head, Some(git::repo::HeadState::Unborn { .. }));

    // bare には作業ツリーが無いので `status` を呼ばない（呼ぶと失敗する）。
    let tree = if probe.is_bare {
        None
    } else {
        git::status::working_tree(log, program, path).ok()
    };

    git::ops::preflight(
        probe.is_bare,
        unborn,
        probe.index_lock_present,
        tree.as_ref(),
    )
}

/// checkout する（docs/DESIGN.md §8.1）。
///
/// **`--force` も自動 stash も無い**（CLAUDE.md §1）。走らせる前に必ず判定を通し、
/// 止める理由が 1 つでもあれば実行しない。
#[tauri::command]
async fn checkout(
    app: AppHandle,
    state: State<'_, AppState>,
    repository_id: String,
    target: git::ops::CheckoutTarget,
) -> Result<git::ops::WriteOutcome, String> {
    let repository = state.store.repository(&repository_id)?;
    let program = git_program(&state);
    let log = state.log.clone();
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&repository.path);
        if !path.is_dir() {
            return Err(format!("フォルダが見つかりません: {}", path.display()));
        }
        let sink = EmittingLog::new(&handle, &log);
        let guard = guard_for(&sink, &program, &path);
        if !guard.allowed() {
            return Ok(refused(&guard));
        }
        git::ops::checkout(&sink, &program, &path, &target)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// fast-forward マージ（docs/DESIGN.md §8.2）。**`--ff-only` 固定**（CLAUDE.md §1）。
#[tauri::command]
async fn merge_ff(
    app: AppHandle,
    state: State<'_, AppState>,
    repository_id: String,
    rev: String,
) -> Result<git::ops::WriteOutcome, String> {
    let repository = state.store.repository(&repository_id)?;
    let program = git_program(&state);
    let log = state.log.clone();
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&repository.path);
        if !path.is_dir() {
            return Err(format!("フォルダが見つかりません: {}", path.display()));
        }
        let sink = EmittingLog::new(&handle, &log);
        let guard = guard_for(&sink, &program, &path);
        if !guard.allowed() {
            return Ok(refused(&guard));
        }
        git::ops::merge_ff(&sink, &program, &path, &rev)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 実行の直前に状態が変わっていたときの返し。**理由はフロントが文言にする**（CLAUDE.md §6）。
fn refused(guard: &git::ops::WriteGuard) -> git::ops::WriteOutcome {
    git::ops::WriteOutcome {
        ok: false,
        message: String::new(),
        details: Vec::new(),
        refused: Some(guard.clone()),
    }
}

/// HEAD と `rev` の ahead/behind（docs/DESIGN.md §8.2）。
///
/// **fast-forward できるのは `ahead == 0 && behind > 0` のときだけ。**
/// `git merge-base --is-ancestor` を呼ばず、`compute_branch_status` と同じ
/// メモリ上のグラフから数える（CLAUDE.md §2）。
///
/// **可視 ref で絞る前の全コミット集合で判定する。** 表示を絞ってもグラフから
/// 消えるだけで、履歴は変わらない。
#[tauri::command]
async fn merge_check(
    app: AppHandle,
    state: State<'_, AppState>,
    repository_id: String,
    rev_sha: String,
) -> Result<MergeCheck, String> {
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

        let index = graph::reach::CommitIndex::new(&snapshot.commits);
        let Some(head) = snapshot.head.sha.as_deref() else {
            return Ok(MergeCheck::unknown());
        };
        Ok(match index.ahead_behind(head, &rev_sha) {
            Some((ahead, behind)) => MergeCheck {
                ahead,
                behind,
                known: true,
            },
            None => MergeCheck::unknown(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// [`merge_check`] の結果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MergeCheck {
    /// HEAD にあって相手に無い数。**0 でないと fast-forward できない。**
    ahead: u32,
    /// 相手にあって HEAD に無い数。取り込む件数。
    behind: u32,
    /// どちらも読み込んだコミット集合にあるか。false なら判定できない。
    known: bool,
}

impl MergeCheck {
    fn unknown() -> Self {
        Self {
            ahead: 0,
            behind: 0,
            known: false,
        }
    }
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

/// コミットメッセージをそのまま（`%B`）。**コピー用**。
///
/// `load_commit_detail` の `subject` + `body` から組み直さない。`%s` は最初の段落を
/// 1 行に潰すので、要約が複数行にまたがるコミットで改行が消える。
#[tauri::command]
async fn load_commit_message(
    app: AppHandle,
    state: State<'_, AppState>,
    repository_id: String,
    sha: String,
) -> Result<String, String> {
    let repository = state.store.repository(&repository_id)?;
    let program = git_program(&state);
    let log = state.log.clone();
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&repository.path);
        if !path.is_dir() {
            return Err(format!("フォルダが見つかりません: {}", path.display()));
        }
        git::diff::commit_message(&EmittingLog::new(&handle, &log), &program, &path, &sha)
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

/// fetch の途中経過をフロントへ送るイベント名。
const FETCH_PROGRESS_EVENT: &str = "fetch-progress";

/// 途中経過に**どのリポジトリのものか**を添えて送る（`SNAPSHOT_PROGRESS_EVENT` と同じ理由）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchProgressEvent<'a> {
    repository_id: &'a str,
    #[serde(flatten)]
    progress: git::fetchprogress::FetchProgress,
    elapsed_ms: u64,
}

/// リモートから取ってくる（docs/DESIGN.md §8.3）。
///
/// **定期実行はしない。** ここを呼ぶのは利用者の操作だけで、タイマーからは呼ばない
/// （認証キャッシュが切れていると、何もしていないのに認証ウィンドウが前面に出る）。
///
/// 一括 fetch は**フロントが 1 件ずつこれを呼ぶ**。並列にすると認証ウィンドウが
/// 同時に何枚も開く。
#[tauri::command]
async fn fetch_repository(
    app: AppHandle,
    state: State<'_, AppState>,
    repository_id: String,
) -> Result<FetchOutcome, String> {
    let repository = state.store.repository(&repository_id)?;
    let program = git_program(&state);
    let log = state.log.clone();
    let handle = app.clone();

    // 中止の合図を先に置く。**実行が終わったら必ず外す**（次の fetch が
    // 前回の「中止済み」を引き継いで即座に止まらないように）。
    let cancel = git::exec::Cancel::new();
    if let Ok(mut slot) = state.fetch_cancel.lock() {
        *slot = Some(cancel.clone());
    }

    let started = std::time::Instant::now();
    let running = cancel.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&repository.path);
        if !path.is_dir() {
            return Err(format!("フォルダが見つかりません: {}", path.display()));
        }
        git::ops::fetch(
            &EmittingLog::new(&handle, &log),
            &program,
            &path,
            &running,
            &mut |progress| {
                let _ = handle.emit(
                    FETCH_PROGRESS_EVENT,
                    FetchProgressEvent {
                        repository_id: &repository.id,
                        progress,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    },
                );
            },
        )
    })
    .await
    .map_err(|error| error.to_string());

    if let Ok(mut slot) = state.fetch_cancel.lock() {
        *slot = None;
    }

    outcome?
}

/// 実行中の fetch を止める。走っていなければ何もしない。
///
/// **止めても、そこまでに更新された ref は戻らない。** 結果の文言でそう伝えている。
#[tauri::command]
async fn cancel_fetch(state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(slot) = state.fetch_cancel.lock() {
        if let Some(cancel) = slot.as_ref() {
            cancel.cancel();
        }
    }
    Ok(())
}

/// clone の途中経過をフロントへ送るイベント名。
///
/// **fetch と分ける。** 同じ名前にすると、fetch の進行ダイアログと clone の
/// 進行ダイアログのどちらが動いているのか区別できなくなる。
const CLONE_PROGRESS_EVENT: &str = "clone-progress";

/// clone の途中経過。**リポジトリ ID はまだ無い**（登録は成功したあと）ので添えない。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloneProgressEvent {
    #[serde(flatten)]
    progress: git::fetchprogress::FetchProgress,
    elapsed_ms: u64,
}

/// URL からリポジトリを clone する（docs/DESIGN.md §8.4）。
///
/// **登録はしない。** 成功したパスを返すだけで、`add_repository` はフロントが呼ぶ
/// （登録して選ぶまでの流れが `store/repositories.ts` に 1 本で置いてあるため）。
#[tauri::command]
async fn clone_repository(
    app: AppHandle,
    state: State<'_, AppState>,
    request: git::ops::CloneRequest,
) -> Result<git::ops::CloneOutcome, String> {
    let program = git_program(&state);
    let log = state.log.clone();
    let handle = app.clone();

    // 中止の合図を先に置く。**実行が終わったら必ず外す**（次の clone が
    // 前回の「中止済み」を引き継いで即座に止まらないように）。
    let cancel = git::exec::Cancel::new();
    if let Ok(mut slot) = state.clone_cancel.lock() {
        *slot = Some(cancel.clone());
    }

    let started = std::time::Instant::now();
    let running = cancel.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        git::ops::clone(
            &EmittingLog::new(&handle, &log),
            &program,
            &request,
            &running,
            &mut |progress| {
                let _ = handle.emit(
                    CLONE_PROGRESS_EVENT,
                    CloneProgressEvent {
                        progress,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    },
                );
            },
        )
    })
    .await
    .map_err(|error| error.to_string());

    if let Ok(mut slot) = state.clone_cancel.lock() {
        *slot = None;
    }

    outcome?
}

/// 実行中の clone を止める。走っていなければ何もしない。
///
/// **止めたら残骸を消す**（`git::ops::clone` の中で行う）。fetch と扱いが違うのは、
/// 途中まで取り込まれたリポジトリには意味が無いため。
#[tauri::command]
async fn cancel_clone(state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(slot) = state.clone_cancel.lock() {
        if let Some(cancel) = slot.as_ref() {
            cancel.cancel();
        }
    }
    Ok(())
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
    // 放置警告の閾値。既定 7 日、0 で無効（docs/DESIGN.md §8.3）。
    let threshold_days = state.store.settings()?.settings.fetch.stale_warning_days;
    let now_ms = now_ms();

    tauri::async_runtime::spawn_blocking(move || {
        let sink = EmittingLog::new(&handle, &log);
        repositories
            .into_iter()
            .map(|settings| {
                let path = PathBuf::from(&settings.path);
                let probe = path
                    .is_dir()
                    .then(|| git::repo::probe(&sink, &program, &path));
                // **判定はここ 1 箇所。** フロントで日数を数え直さない。
                let fetch_stale = probe.as_ref().is_some_and(|probe| {
                    git::ops::is_stale(
                        !probe.remotes.is_empty(),
                        probe.last_fetch_at_ms,
                        now_ms,
                        threshold_days,
                    )
                });
                RepositoryEntry {
                    settings,
                    probe,
                    fetch_stale,
                }
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

/// API キーの扱い方。**フロントは「空欄＝変えない」を自分で判断しない。**
///
/// 空欄のまま保存したときに既存のキーを消してしまう事故を、`Option` ではなく
/// 種類で塞いである（真偽値を並べると成り立たない組み合わせが表現できてしまう）。
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ApiKeyUpdate {
    /// 触らない。編集フォームで API キー欄を空のまま保存したとき。
    Keep,
    /// 差し替える。
    Replace { value: String },
    /// 保存済みのキーを消す（キーの要らない接続先へ変えたとき）。
    Clear,
}

/// LLM プロファイルを保存する。**新規なら ID と参照キーはここで採番される。**
///
/// API キーの平文が通るのはこの経路だけで、行き先は資格情報マネージャーだけ。
/// `settings.json` へ書くのは参照キーだけ（CLAUDE.md §4）。
#[tauri::command]
fn save_llm_profile(
    state: State<'_, AppState>,
    profile: store::settings::LlmProfile,
    api_key: ApiKeyUpdate,
) -> Result<store::settings::LlmProfile, String> {
    let stored = state.store.upsert_llm_profile(profile)?;
    let secrets = secret::Secrets::new();
    match api_key {
        ApiKeyUpdate::Keep => {}
        // 空文字を「預ける」意味は無いので消す扱いにする。フロントは空欄を
        // `Keep` として送るので、ここへ来るのは手で組み立てた JSON だけ。
        ApiKeyUpdate::Replace { value } if value.is_empty() => {
            secrets.delete(&stored.credential_key)?
        }
        ApiKeyUpdate::Replace { value } => secrets.save(&stored.credential_key, &value)?,
        ApiKeyUpdate::Clear => secrets.delete(&stored.credential_key)?,
    }
    Ok(stored)
}

/// LLM プロファイルを消す。**資格情報も一緒に消す**（孤児を残さない）。
#[tauri::command]
fn delete_llm_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(removed) = state.store.remove_llm_profile(&id)? {
        secret::Secrets::new().delete(&removed.credential_key)?;
    }
    Ok(())
}

/// API キーが保存済みのプロファイルの参照キー。**値そのものは返さない。**
///
/// 画面の「保存済み」表示に使う。既存のキーを読み出して見せる経路は作らない。
#[tauri::command]
fn llm_credential_keys(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let secrets = secret::Secrets::new();
    Ok(state
        .store
        .llm_profiles()?
        .into_iter()
        .map(|profile| profile.credential_key)
        .filter(|key| !key.is_empty() && secrets.has(key))
        .collect())
}

/// 通信に要るもの一式を、**保存済みのプロファイル**から揃える。
///
/// フロントから平文のキーを受け取って試す形にはしない。試すために保存が要るぶん
/// 手間だが、**キーが通る経路を「保存」1 つに閉じられる**（CLAUDE.md §4）。
/// 押せない理由は画面が出す（`lib/llmProfile.ts` の `probeOption`）。
fn saved_endpoint(
    state: &State<'_, AppState>,
    id: &str,
) -> Result<(store::settings::LlmProfile, String), llm::client::LlmError> {
    let profile = state
        .store
        .llm_profile(id)
        .map_err(llm::client::LlmError::config)?;
    let api_key = secret::Secrets::new()
        .load(&profile.credential_key)
        .map_err(llm::client::LlmError::config)?
        // キーが無いのは失敗ではない。Ollama は認証不要で、空なら
        // `Authorization` が付かない（`llm/client.rs`）。
        .unwrap_or_default();
    Ok((profile, api_key))
}

/// モデル名の候補。**取れなくても手入力できる**ので、失敗しても保存は妨げない。
#[tauri::command]
async fn list_llm_models(
    state: State<'_, AppState>,
    id: String,
) -> Result<llm::client::ModelList, llm::client::LlmError> {
    let (profile, api_key) = saved_endpoint(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || llm::client::list_models(&profile, &api_key))
        .await
        .map_err(|error| llm::client::LlmError::config(error.to_string()))?
}

/// 接続テスト。**`/v1/models` では済ませず、実際に 1 往復させる。**
#[tauri::command]
async fn test_llm_connection(
    state: State<'_, AppState>,
    id: String,
) -> Result<llm::client::TestOutcome, llm::client::LlmError> {
    let (profile, api_key) = saved_endpoint(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || llm::client::test_connection(&profile, &api_key))
        .await
        .map_err(|error| llm::client::LlmError::config(error.to_string()))?
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
                fetch_cancel: Mutex::new(None),
                clone_cancel: Mutex::new(None),
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
            load_commit_message,
            load_changed_files,
            load_file_diff,
            load_working_tree,
            load_working_file,
            fetch_repository,
            cancel_fetch,
            clone_repository,
            cancel_clone,
            preflight_write,
            checkout,
            merge_ff,
            merge_check,
            load_settings,
            save_settings,
            load_ui_state,
            save_ui_state,
            app_data_dir,
            save_llm_profile,
            delete_llm_profile,
            llm_credential_keys,
            list_llm_models,
            test_llm_connection,
            load_skills,
            set_skill_use,
            set_skill_extra
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

/// レビュー skill を読む。`repository_id` が `None` ならリポジトリ内は見ない。
///
/// **リポジトリ内 skill は「使う」と決めたファイルだけ本文が付く**（`llm/skill.rs`）。
/// ここは読んで返すだけで、信頼の判定を書き足さないこと（CLAUDE.md §4）。
#[tauri::command]
async fn load_skills(
    state: State<'_, AppState>,
    repository_id: Option<String>,
) -> Result<llm::skill::SkillCatalog, String> {
    read_skills(&state, repository_id.as_deref()).await
}

/// 読み込みの実体。書き換えたあとも必ずここを通して返す（フロントで組み直させない）。
async fn read_skills(
    state: &State<'_, AppState>,
    repository_id: Option<&str>,
) -> Result<llm::skill::SkillCatalog, String> {
    let payload = state.store.settings()?;
    let global = state.store.paths()?.skills_dir();
    let skills = payload.settings.skills.clone();

    let repository = match repository_id {
        Some(id) => {
            let settings = state.store.repository(id)?;
            Some((PathBuf::from(settings.path), settings.repo_skills))
        }
        None => None,
    };

    tauri::async_runtime::spawn_blocking(move || match repository {
        Some((path, trust)) => llm::skill::load(&global, Some(&path), &trust, &skills),
        None => llm::skill::load(&global, None, &Default::default(), &skills),
    })
    .await
    .map_err(|error| error.to_string())
}

/// どの skill を指しているか。
///
/// **内蔵とグローバルは名前で、リポジトリ内はファイル名で指す。**
/// リポジトリ内は「どのファイルの内容を信頼したか」が要点なので、
/// frontmatter の `name` を書き換えても記録が付いて回らないようにファイル名を鍵にする。
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "scope", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum SkillTarget {
    /// 内蔵とグローバル。
    Global { name: String },
    /// リポジトリ内。
    Repository { repository_id: String, file: String },
}

/// skill を使う / 使わないを決める。
///
/// **リポジトリ内 skill では「使う」＝ その内容を信頼すること。** `seen_hash` は
/// 画面が見せていた内容のハッシュで、実物と食い違ったら記録しない
/// （表示してから押すまでの間に書き換えられる隙を残さない）。
#[tauri::command]
async fn set_skill_use(
    state: State<'_, AppState>,
    target: SkillTarget,
    use_skill: bool,
    seen_hash: Option<String>,
) -> Result<llm::skill::SkillCatalog, String> {
    match &target {
        SkillTarget::Global { name } => {
            state.store.set_skill_use(name, use_skill)?;
            read_skills(&state, None).await
        }
        SkillTarget::Repository {
            repository_id,
            file,
        } => {
            let hash = if use_skill {
                let root = PathBuf::from(state.store.repository(repository_id)?.path);
                let file = file.clone();
                let current =
                    tauri::async_runtime::spawn_blocking(move || llm::skill::file_hash(&root, &file))
                        .await
                        .map_err(|error| error.to_string())?
                        .ok_or("ファイルが見つかりません。一覧を開き直してください。")?;
                // **読んでいない内容を信頼しない。**
                if seen_hash.as_deref() != Some(current.as_str()) {
                    return Err(
                        "表示していた内容とファイルが違います。中身を読み直してから決めてください。"
                            .to_string(),
                    );
                }
                Some(current)
            } else {
                None
            };

            state
                .store
                .set_repo_skill_use(repository_id, file, hash)?;
            read_skills(&state, Some(repository_id)).await
        }
    }
}

/// skill の本文の後ろへ足す一言を保存する。
///
/// **skill ファイルは書き換えない。** 他人のリポジトリの skill にも足せるし、
/// 信頼のハッシュも壊れない。
#[tauri::command]
async fn set_skill_extra(
    state: State<'_, AppState>,
    target: SkillTarget,
    extra: String,
) -> Result<llm::skill::SkillCatalog, String> {
    match &target {
        SkillTarget::Global { name } => {
            state.store.set_skill_extra(name, &extra)?;
            read_skills(&state, None).await
        }
        SkillTarget::Repository {
            repository_id,
            file,
        } => {
            state
                .store
                .set_repo_skill_extra(repository_id, file, &extra)?;
            read_skills(&state, Some(repository_id)).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ApiKeyUpdate, SkillTarget};
    use crate::store::settings::LlmProfile;

    /// **フロントが送る JSON をそのまま食えること**（T-18 / T-19 の申し送り）。
    ///
    /// 引数の組み立てだけを固定しても、受け取りの形が違えばコマンドは 1 度も走らない。
    /// `serde` の `rename_all` は**変種の名前しか変えない**ので、フィールドは
    /// `rename_all_fields` が要る（T-18 で落として嵌まった）。
    #[test]
    fn the_llm_profile_wire_format_matches_what_the_front_end_sends() {
        let parsed: LlmProfile = serde_json::from_str(
            r#"{"id":"","name":"ローカル","baseUrl":"http://localhost:11434/v1",
                "model":"qwen2.5-coder:14b","contextWindow":32768,"temperature":0.2,
                "maxTokens":4096,"credentialKey":""}"#,
        )
        .expect("フロントの JSON を食えること");

        assert_eq!(parsed.name, "ローカル");
        assert_eq!(parsed.base_url, "http://localhost:11434/v1");
        assert_eq!(parsed.context_window, 32_768);
        assert_eq!(parsed.max_tokens, 4_096);
    }

    /// **フロントが送る skill の宛先をそのまま食えること**（T-18 / T-19 の申し送り）。
    ///
    /// `rename_all` は変種の名前しか変えないので、フィールドは `rename_all_fields` が要る。
    #[test]
    fn the_skill_target_wire_format_matches_what_the_front_end_sends() {
        let global = serde_json::from_str::<SkillTarget>(
            r#"{"scope":"global","name":"general-review"}"#,
        )
        .expect("global を食えること");
        match global {
            SkillTarget::Global { name } => assert_eq!(name, "general-review"),
            other => panic!("global として読めていない: {other:?}"),
        }

        let repository = serde_json::from_str::<SkillTarget>(
            r#"{"scope":"repository","repositoryId":"r1","file":"repo-review.md"}"#,
        )
        .expect("repository を食えること");
        match repository {
            SkillTarget::Repository {
                repository_id,
                file,
            } => {
                assert_eq!(repository_id, "r1");
                assert_eq!(file, "repo-review.md");
            }
            other => panic!("repository として読めていない: {other:?}"),
        }

        // **知らない scope を黙って握り潰さない。** グローバルの設定を書き換えるつもりが
        // リポジトリのものを書き換える、といった取り違えを型で止める。
        assert!(serde_json::from_str::<SkillTarget>(r#"{"scope":"whatever"}"#).is_err());
        // スネークケースで送っても通してはいけない（通すと片方だけ直して気付けない）。
        assert!(serde_json::from_str::<SkillTarget>(
            r#"{"scope":"repository","repository_id":"r1","file":"a.md"}"#
        )
        .is_err());
    }

    /// API キーの扱いは 3 通りある。**`value` のキー名まで食えること。**
    #[test]
    fn the_api_key_update_wire_format_matches_what_the_front_end_sends() {
        assert!(matches!(
            serde_json::from_str::<ApiKeyUpdate>(r#"{"kind":"keep"}"#).expect("keep"),
            ApiKeyUpdate::Keep
        ));
        assert!(matches!(
            serde_json::from_str::<ApiKeyUpdate>(r#"{"kind":"clear"}"#).expect("clear"),
            ApiKeyUpdate::Clear
        ));

        let replace = serde_json::from_str::<ApiKeyUpdate>(
            r#"{"kind":"replace","value":"sk-example-0123456789"}"#,
        )
        .expect("replace");
        match replace {
            ApiKeyUpdate::Replace { value } => assert_eq!(value, "sk-example-0123456789"),
            other => panic!("replace として読めていない: {other:?}"),
        }

        // **知らない種類を黙って握り潰さない。** 既定へ倒すと、キーを消すつもりの
        // 操作が「触らない」に化ける。
        assert!(serde_json::from_str::<ApiKeyUpdate>(r#"{"kind":"whatever"}"#).is_err());
        assert!(serde_json::from_str::<ApiKeyUpdate>(r#"{"kind":"replace"}"#).is_err());
    }
}
