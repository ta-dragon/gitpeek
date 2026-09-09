pub mod commandlog;
pub mod encoding;
pub mod git;
pub mod graph;
pub mod llm;
pub mod logging;
pub mod model;
mod redact;
pub mod secret;
pub mod store;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State};

use commandlog::{CommandLog, CommandLogEntry, EmittingLog};
use logging::LogStatus;
use git::detect::GitStatus;
use encoding::TextEncoding;
use git::diff::{CommitDetail, DiffOptions, DiffSource, DiffTarget, FileChange, FileDiff};
use git::ops::{FetchOutcome, MergeCheck};
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
    /// 実行中の AI レビューを止めるための合図（T-22）。
    ///
    /// fetch / clone と**別に持つ**のは同じ理由。レビューは分単位で走るので、
    /// 途中で fetch を始めても中止ボタンが効かなくならないようにする。
    pub review_cancel: Mutex<Option<git::exec::Cancel>>,
    /// ログの置き場所と、書けているかどうか（T-24）。
    ///
    /// **書けなくてもアプリは止めない**が、黙って落とすと「書いているつもり」に
    /// なるので、理由を画面へ出せるようにここへ残す（CLAUDE.md §6）。
    pub log_status: LogStatus,
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

    // **git があるかどうかは、後から追うとき最初に見る**（T-24）。
    // 個々の git 実行は `commandlog.rs` が残すので、ここは判定の結果だけ。
    if status.usable() {
        log::info!(
            target: "app",
            "git を検出しました: {} {}",
            status.path,
            status.version.as_deref().unwrap_or("（版が読めない）")
        );
    } else {
        log::warn!(
            target: "app",
            "git を使えません: {} found={} versionOk={} {}",
            status.path,
            status.found,
            status.version_ok,
            status.error.as_deref().unwrap_or("")
        );
    }

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

        Ok(merge_check_of(&snapshot, &rev_sha))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// スナップショットから ahead/behind を数える（docs/DESIGN.md §8.2）。
///
/// **判定を書くのはここ 1 か所。** [`merge_check`] コマンドと
/// 「取ってきて取り込む」（[`fetch_and_merge`]）の両方がここを通る。二重に書くと、
/// 「確認画面が言ったこと」と「実際に走らせた条件」が食い違う。
///
/// `pub` なのは**結合テストから同じ判定を呼ぶため**（`tests/writeops.rs`）。
/// テストが自前で数えると、判定そのものは一度も試されない。
pub fn merge_check_of(snapshot: &RepositorySnapshot, rev_sha: &str) -> MergeCheck {
    // detached は数と無関係に決まる。**判定できないときも落とさない**
    // （「取り込む先が無い」のか「数えられなかった」のかで文言が変わる）。
    let detached = snapshot.head.branch.is_none();

    let Some(head) = snapshot.head.sha.as_deref() else {
        return MergeCheck::unknown(detached);
    };
    let index = graph::reach::CommitIndex::new(&snapshot.commits);
    match index.ahead_behind(head, rev_sha) {
        Some((ahead, behind)) => MergeCheck {
            ahead,
            behind,
            known: true,
            detached,
        },
        None => MergeCheck::unknown(detached),
    }
}

/// 完全な ref 名から数える（`refs/remotes/origin/main`）。
///
/// **fetch のあとは ref の指す先が変わっている**ので、確認画面が持っていた SHA では
/// なく、取り直したスナップショットで引き直す。名前が見つからなければ「判定できない」
/// （上流が消えた場合。ここで勝手に別の ref を選ばない）。
pub fn merge_check_of_ref(snapshot: &RepositorySnapshot, rev: &str) -> MergeCheck {
    match snapshot.refs.iter().find(|entry| entry.name == rev) {
        Some(entry) => merge_check_of(snapshot, &entry.target),
        None => MergeCheck::unknown(snapshot.head.branch.is_none()),
    }
}

/// 「取ってきて取り込む」の段が変わったことを知らせるイベント名（T-31）。
///
/// **中止できるのは fetch の間だけ**なので、取り込みへ移ったことを画面へ伝える
/// 必要がある。伝えないと、効かない中止ボタンが押せるまま残る。
const FETCH_MERGE_PHASE_EVENT: &str = "fetch-merge-phase";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchMergePhaseEvent<'a> {
    repository_id: &'a str,
    /// いまのところ `merging` だけ。fetch の段はコマンドを呼んだ側が知っている。
    phase: &'a str,
}

/// 取ってきて、早送りできるならそのまま取り込む（docs/DESIGN.md §8.6。T-31）。
///
/// **`git pull` は呼ばない。** 既存の fetch と `merge --ff-only` を順に呼ぶだけで、
/// 順番と失敗時の扱いは [`git::ops::fetch_and_merge`] が持つ。ここが渡すのは
/// アプリ側の材料だけ — 判定（[`guard_for`]）、中止の合図、進捗の送り先、
/// そして**取り込む前の判定**（スナップショットを取り直して数える）。
///
/// **中止は既存の `cancel_fetch` が効く。** ただし取り込みが始まったあとは効かない。
#[tauri::command]
async fn fetch_and_merge(
    app: AppHandle,
    state: State<'_, AppState>,
    request: git::ops::FetchMergeRequest,
) -> Result<git::ops::FetchMergeOutcome, String> {
    let repository = state.store.repository(&request.repository_id)?;
    let program = git_program(&state);
    let log = state.log.clone();
    let cache = state.snapshots.clone();
    let handle = app.clone();

    // 中止の合図は fetch と同じスロットを使う。**実行が終わったら必ず外す。**
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
        let sink = EmittingLog::new(&handle, &log);

        // **判定は fetch の前に 1 度。** 通らなければ fetch もしない
        // （docs/DESIGN.md §8.6）。取ってくる間に汚れた場合は git が取り込みを拒む。
        let guard = guard_for(&sink, &program, &path);

        let mut on_progress = |progress: git::fetchprogress::FetchProgress| {
            let _ = handle.emit(
                FETCH_PROGRESS_EVENT,
                FetchProgressEvent {
                    repository_id: &repository.id,
                    progress,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                },
            );
        };
        let mut on_merging = || {
            let _ = handle.emit(
                FETCH_MERGE_PHASE_EVENT,
                FetchMergePhaseEvent {
                    repository_id: &repository.id,
                    phase: "merging",
                },
            );
        };
        let mut check = || {
            // **ref が動いているので読み直す。** `load_cached` は ref の指紋が
            // 変わっていれば自分で取り直すので、force は立てない。
            let snapshot = git::snapshot::load_cached(
                &sink,
                &program,
                &path,
                &cache,
                &repository.id,
                false,
                &Reporting::silent(),
            )?;
            Ok(merge_check_of_ref(&snapshot, &request.rev))
        };

        git::ops::fetch_and_merge(
            &sink,
            &program,
            &path,
            &request.rev,
            &guard,
            &running,
            git::ops::FetchMergeHooks {
                on_progress: &mut on_progress,
                on_merging: &mut on_merging,
                check: &mut check,
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

/// レビューの途中経過をフロントへ送るイベント名。
///
/// **fetch / clone と分ける**（どれが動いているのか区別できなくなるため）。
const REVIEW_PROGRESS_EVENT: &str = "review-progress";

/// 途中経過に**どの走りのものか**を添えて送る。
///
/// 中止してすぐ次を始めると、前の走りの残りが後から届く。`runId` が無いと
/// 画面が別の走りの本文を混ぜてしまう。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewProgressEvent<'a> {
    run_id: &'a str,
    #[serde(flatten)]
    event: llm::review::ReviewEvent,
}

/// 途中経過を webview へ流す [`llm::review::ReviewSink`]。
///
/// review 側のコードを `AppHandle` に依存させないため、Tauri に触るのはここだけ
/// （`EmittingProgress` と同じ形）。
struct EmittingReview<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    run_id: &'a str,
}

impl<R: Runtime> llm::review::ReviewSink for EmittingReview<'_, R> {
    fn report(&self, event: llm::review::ReviewEvent) {
        let _ = self.app.emit(
            REVIEW_PROGRESS_EVENT,
            ReviewProgressEvent {
                run_id: self.run_id,
                event,
            },
        );
    }
}

/// レビューに要るものを揃える。**プロファイルと skill の読み込みはここ 1 箇所。**
///
/// `plan_review` と `start_review` で作り方が違うと、
/// 画面に出した計画と実際に投げるものがずれる。
struct ReviewSetup {
    program: String,
    repo: PathBuf,
    profile: store::settings::LlmProfile,
    api_key: String,
    skills: Vec<llm::skill::SkillEntry>,
    context_lines: u32,
    concurrency: u8,
}

async fn review_setup(
    state: &State<'_, AppState>,
    repository_id: &str,
    profile_id: &str,
) -> Result<ReviewSetup, llm::client::LlmError> {
    let repository = state
        .store
        .repository(repository_id)
        .map_err(llm::client::LlmError::config)?;
    let repo = PathBuf::from(&repository.path);
    if !repo.is_dir() {
        return Err(llm::client::LlmError::config(format!(
            "フォルダが見つかりません: {}",
            repo.display()
        )));
    }
    let (profile, api_key) = saved_endpoint(state, profile_id)?;
    let payload = state
        .store
        .settings()
        .map_err(llm::client::LlmError::config)?;
    let catalog = read_skills(state, Some(repository_id))
        .await
        .map_err(llm::client::LlmError::config)?;

    Ok(ReviewSetup {
        program: git_program(state),
        repo,
        profile,
        api_key,
        skills: catalog.entries,
        context_lines: u32::from(payload.settings.review.context_lines),
        concurrency: payload.settings.review.concurrency,
    })
}

/// 実行前パネルの中身（DESIGN.md §10.4）。
///
/// **見積もりも分割数もここで決める。** フロントに同じ計算を置くと必ずずれる。
#[tauri::command]
async fn plan_review(
    app: AppHandle,
    state: State<'_, AppState>,
    repository_id: String,
    source: DiffSource,
    profile_id: String,
) -> Result<llm::review::ReviewPlan, llm::client::LlmError> {
    let setup = review_setup(&state, &repository_id, &profile_id).await?;
    let log = state.log.clone();
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        llm::review::plan(&llm::review::ReviewContext {
            log: &EmittingLog::new(&handle, &log),
            program: &setup.program,
            repo: &setup.repo,
            source: &source,
            profile: &setup.profile,
            api_key: &setup.api_key,
            skills: &setup.skills,
            context_lines: setup.context_lines,
            concurrency: setup.concurrency,
        })
        .map_err(llm::client::LlmError::config)
    })
    .await
    .map_err(|error| llm::client::LlmError::config(error.to_string()))?
}

/// レビューを走らせる（DESIGN.md §10.5〜§10.7）。
///
/// `paths` は実行前パネルで**残された**ファイル。計画そのものは Rust 側で組み直す
/// （古い計画で走らせない）。`run_id` はフロントが採番して渡す —
/// **走り始める前にイベントの受け口を用意できる**ようにするため。
///
/// **走り終えたらここで保存する**（T-23）。フロントに保存させると、
/// 例外や画面遷移で**保存し忘れる経路**ができる。中止したものも積む
/// （途中まででも読む価値があり、捨てるほうが損）。
#[tauri::command]
async fn start_review(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    repository_id: String,
    source: DiffSource,
    profile_id: String,
    paths: Vec<String>,
) -> Result<store::reviews::StoredReview, llm::client::LlmError> {
    let setup = review_setup(&state, &repository_id, &profile_id).await?;
    let log = state.log.clone();
    let handle = app.clone();
    // **保存に使うぶんは手元に残す。** `setup` はブロッキングタスクへ渡ってしまう。
    let profile = setup.profile.clone();

    // 中止の合図を先に置く。**終わったら必ず外す**（次の走りが「中止済み」を
    // 引き継いで即座に止まらないように）。
    let cancel = git::exec::Cancel::new();
    if let Ok(mut slot) = state.review_cancel.lock() {
        *slot = Some(cancel.clone());
    }

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        llm::review::run(
            &llm::review::ReviewContext {
                log: &EmittingLog::new(&handle, &log),
                program: &setup.program,
                repo: &setup.repo,
                source: &source,
                profile: &setup.profile,
                api_key: &setup.api_key,
                skills: &setup.skills,
                context_lines: setup.context_lines,
                concurrency: setup.concurrency,
            },
            &paths,
            &cancel,
            &EmittingReview {
                app: &handle,
                run_id: &run_id,
            },
        )
        .map_err(llm::client::LlmError::config)
    })
    .await
    .map_err(|error| llm::client::LlmError::config(error.to_string()));

    if let Ok(mut slot) = state.review_cancel.lock() {
        *slot = None;
    }

    let run = outcome??;
    let store_paths = state
        .store
        .paths()
        .map_err(llm::client::LlmError::config)?;
    store::reviews::save(store_paths, &repository_id, &profile, run)
        .map_err(llm::client::LlmError::config)
}

/// レビューの履歴（新しい順）。**読めないものも理由付きで並ぶ。**
#[tauri::command]
fn list_reviews(
    state: State<'_, AppState>,
    repository_id: String,
) -> Result<Vec<store::reviews::ReviewIndexRow>, String> {
    Ok(store::reviews::list(state.store.paths()?, &repository_id))
}

/// 履歴 1 件の全文。
#[tauri::command]
fn load_review(
    state: State<'_, AppState>,
    repository_id: String,
    file: String,
) -> Result<store::reviews::StoredReview, String> {
    store::reviews::load(state.store.paths()?, &repository_id, &file)
}

/// 利用者が保存ダイアログで選んだパスへ、組み立て済みのテキストを書く。
///
/// 用途は 2 つ。**レビュー結果の Markdown**（DESIGN.md §12.4）と
/// **ブランチ一覧の CSV**（T-32）。どちらも**組み立てはフロントの純関数**で、
/// ここは書くだけ（`lib/reviewMarkdown.ts` と `lib/branchCsv.ts`）。
///
/// **`tauri-plugin-fs` は入れない。** 依存 2 つ（npm と Cargo）と引き換えに
/// 得られるのは「任意のファイルを書く」機能で、要るのは書き出しだけ。
/// **行き先は保存ダイアログで選ばれたパスに限る**（フロントが勝手に決めた
/// パスは来ない。開く側の `open_repository_folder` と同じ考え方。CLAUDE.md §4）。
#[tauri::command]
async fn export_text(path: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        store::json::write_atomic(&PathBuf::from(&path), &text)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// リポジトリごとの既定 LLM プロファイルを覚える（DESIGN.md §10.2）。
///
/// **リポジトリに紐づくものなので、アプリ全体の設定に混ぜない**（CLAUDE.md §6）。
#[tauri::command]
fn set_repository_llm_profile(
    state: State<'_, AppState>,
    repository_id: String,
    profile_id: Option<String>,
) -> Result<(), String> {
    state
        .store
        .set_repository_llm_profile(&repository_id, profile_id.as_deref())
}

/// 実行中のレビューを止める。走っていなければ何もしない。
///
/// **チャンクが届いた時点で効く。** 黙り込んだ接続先を相手にしているときだけ、
/// 読み取りが返るまで畳まれない（fetch と同じ割り切り。DESIGN.md §8.3）。
#[tauri::command]
async fn cancel_review(state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(slot) = state.review_cancel.lock() {
        if let Some(cancel) = slot.as_ref() {
            cancel.cancel();
        }
    }
    Ok(())
}

/* ---------- ログ（T-24。docs/DESIGN.md §13.3）---------- */

/// ログを始める。**書けなくても起動を止めない。**
///
/// 順番に意味がある。**掃除 → プラグイン → panic hook → 最初の 1 行**。
/// hook を先に入れるとログがまだ無く、panic の記録先が標準エラーだけになる。
fn start_logging(app: &AppHandle, store: &Store) -> LogStatus {
    let today = chrono::Local::now().date_naive();

    let Ok(paths) = store.paths() else {
        // データディレクトリすら用意できていない。**この場合は全コマンドが
        // 理由付きで失敗する**ので、ログが無いこと自体は主因ではない。
        return LogStatus {
            dir: String::new(),
            writing: false,
            problem: Some("設定の置き場所を用意できなかったため、ログを残せません。".to_string()),
        };
    };
    let dir = paths.logs_dir();

    // **古いものを先に消す**（7 日。DESIGN.md §13.3）。消せなくても続ける。
    logging::sweep(&dir, today, logging::KEEP_DAYS);

    let mut status = LogStatus {
        dir: logging::dir_display(&dir),
        writing: true,
        problem: None,
    };
    if let Err(error) = app.plugin(logging::plugin(&dir, today)) {
        status.writing = false;
        status.problem = Some(format!("ログファイルに書けません: {error}"));
        return status;
    }

    logging::install_panic_hook(app.clone());
    log::info!(
        target: "app",
        "GitPeek {} を起動しました（設定: {}）",
        app.package_info().version,
        paths.root().display()
    );

    // **設定を読めなかったことも残す**（T-24）。`Store::init` はログより先に
    // 走るので、ここで結果だけ書き写す（読めていれば何も書かない）。
    match store.settings() {
        Ok(payload) => {
            if let Some(recovery) = payload.recovered {
                log::warn!(
                    target: "app",
                    "settings.json を読めなかったため既定値で起動しました（{}）。元の内容は {} へ退避しました",
                    recovery.reason,
                    recovery.backup_path
                );
            }
        }
        Err(error) => log::warn!(target: "app", "設定を読めません: {error}"),
    }

    status
}

/// ログの置き場所と、書けているかどうか（T-24）。
///
/// **書けていないことを画面に出す**ために返す（CLAUDE.md §6）。
#[tauri::command]
fn log_status(state: State<'_, AppState>) -> LogStatus {
    state.log_status.clone()
}

/// ログフォルダを開く。
///
/// **capability は広げない。** 開けるのはこのフォルダだけで、フロントから
/// 任意のパスを渡せる形にしない（`opener:allow-open-path` を足すと、
/// 画面側から何でも開けるようになる）。
#[tauri::command]
fn open_log_folder(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    if state.log_status.dir.is_empty() {
        return Err("ログの置き場所が決まっていません。".to_string());
    }
    app.opener()
        .open_path(state.log_status.dir.clone(), None::<&str>)
        .map_err(|error| format!("ログフォルダを開けません: {error}"))
}

/// 登録済みリポジトリのフォルダをエクスプローラで開く（T-30）。
///
/// **受け取るのは登録の ID だけで、パスはフロントから渡させない**
/// （`open_log_folder` と同じ形）。パスを引数にすると、画面側から
/// 任意の場所を開けるコマンドになる。
///
/// 開く前に**実在するフォルダかを確かめる**。登録したあとで移動・削除された
/// リポジトリはよくあるので、エクスプローラに空振りさせるより理由を返す。
#[tauri::command]
fn open_repository_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    repository_id: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let repository = state.store.repository(&repository_id)?;
    let path = std::path::Path::new(&repository.path);
    if !path.is_dir() {
        return Err(format!("フォルダが見つかりません: {}", repository.path));
    }
    app.opener()
        .open_path(repository.path.clone(), None::<&str>)
        .map_err(|error| format!("フォルダを開けません: {error}"))
}

/// フロントで起きた例外をログへ残す（T-24）。
///
/// 画面の受け皿（`ErrorBoundary`）は閉じると何も残らない。**Rust 側の記録と
/// 同じファイルに並ぶ**ほうが後から辿りやすい。マスキングは書き出しの口で通る。
#[tauri::command]
fn log_frontend_error(message: String) {
    log::error!(target: "ui", "{message}");
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
            let log_status = start_logging(app.handle(), &store);
            app.manage(AppState {
                log: Arc::new(CommandLog::default()),
                git_path: Mutex::new(None),
                store,
                snapshots: Arc::new(SnapshotCache::new()),
                fetch_cancel: Mutex::new(None),
                clone_cancel: Mutex::new(None),
                review_cancel: Mutex::new(None),
                log_status,
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
            fetch_and_merge,
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
            set_skill_extra,
            plan_review,
            start_review,
            cancel_review,
            list_reviews,
            load_review,
            export_text,
            set_repository_llm_profile,
            log_status,
            open_log_folder,
            open_repository_folder,
            log_frontend_error
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

    /// **フロントが送るレビューの依頼をそのまま食えること**（T-18 / T-21 の申し送り）。
    ///
    /// `DiffSource` は差分ペインとレビューで**共用している**ので、
    /// ここが通れば `load_file_diff` 側も同じ形で通る。
    #[test]
    fn the_review_request_wire_format_matches_what_the_front_end_sends() {
        use crate::git::diff::DiffSource;

        let range = serde_json::from_str::<DiffSource>(
            r#"{"kind":"range","parent":"aaa","sha":"bbb","symmetric":false}"#,
        )
        .expect("range を食えること");
        match &range {
            DiffSource::Range {
                parent,
                sha,
                symmetric,
            } => {
                assert_eq!(parent.as_deref(), Some("aaa"));
                assert_eq!(sha, "bbb");
                assert!(!symmetric);
            }
            other => panic!("range として読めていない: {other:?}"),
        }

        // ルートコミットは `parent` が null。
        let root = serde_json::from_str::<DiffSource>(
            r#"{"kind":"range","parent":null,"sha":"bbb","symmetric":false}"#,
        )
        .expect("ルートコミットを食えること");
        assert!(matches!(root, DiffSource::Range { parent: None, .. }));

        let working = serde_json::from_str::<DiffSource>(
            r#"{"kind":"workingTree","staged":true}"#,
        )
        .expect("workingTree を食えること");
        assert!(matches!(
            working,
            DiffSource::WorkingTree { staged: true }
        ));

        // **知らない kind を黙って握り潰さない。**
        assert!(serde_json::from_str::<DiffSource>(r#"{"kind":"whatever"}"#).is_err());
        // スネークケースで送っても通してはいけない（片方だけ直して気付けなくなる）。
        assert!(serde_json::from_str::<DiffSource>(
            r#"{"kind":"working_tree","staged":true}"#
        )
        .is_err());
    }

    /// **フロントが読む形を固定する**（T-21 の申し送り）。
    ///
    /// 形が違えば画面は黙って空になる。あわせて
    /// **skill の本文がフロントへ渡らないこと**もここで押さえる。
    #[test]
    fn the_review_wire_format_matches_what_the_front_end_reads() {
        use crate::git::diff::{ChangeStatus, DiffSource};
        use crate::llm::review::{
            Finding, PlannedFile, PlannedSkill, ReviewEvent, ReviewFileResult, ReviewPlan,
            ReviewRun, ReviewText, Severity,
        };
        use crate::llm::skill::SkillOrigin;

        let plan = ReviewPlan {
            files: vec![PlannedFile {
                path: "a.txt".to_string(),
                old_path: Some("b.txt".to_string()),
                status: ChangeStatus::Renamed,
                tokens_estimate: 12,
                parts: 2,
                skipped: None,
            }],
            skills: vec![PlannedSkill {
                name: "general-review".to_string(),
                origin: SkillOrigin::BuiltIn,
            }],
            tokens_estimate: 12,
            blocked: Some("観点がありません".to_string()),
        };
        let json = serde_json::to_value(&plan).unwrap();
        assert_eq!(json["files"][0]["oldPath"], "b.txt");
        assert_eq!(json["files"][0]["status"], "renamed");
        assert_eq!(json["files"][0]["tokensEstimate"], 12);
        assert_eq!(json["files"][0]["parts"], 2);
        assert_eq!(json["files"][0]["skipped"], serde_json::Value::Null);
        assert_eq!(json["skills"][0]["origin"], "builtIn");
        assert_eq!(json["tokensEstimate"], 12);
        assert_eq!(json["blocked"], "観点がありません");

        let text = ReviewText {
            summary: "要約".to_string(),
            findings: vec![Finding {
                file: "a.txt".to_string(),
                line: Some(3),
                severity: Severity::Critical,
                title: "見出し".to_string(),
                message: "本文".to_string(),
            }],
            markdown: Some("生出力".to_string()),
            fallback_reason: Some("構造化に失敗しました".to_string()),
        };
        let run = ReviewRun {
            run_id: "r1".to_string(),
            profile_id: "p1".to_string(),
            model: "m".to_string(),
            source: DiffSource::WorkingTree { staged: false },
            skills: plan.skills.clone(),
            files: vec![ReviewFileResult {
                path: "a.txt".to_string(),
                old_path: None,
                parts: 1,
                text: Some(text.clone()),
                error: Some(crate::llm::client::LlmError::config("だめでした")),
                tokens_estimate: 4,
                elapsed_ms: 5,
            }],
            summary: Some(text.clone()),
            failed: 1,
            cancelled: true,
            started_at: 1_700_000_000_000,
            elapsed_ms: 9,
        };
        let json = serde_json::to_value(&run).unwrap();
        assert_eq!(json["runId"], "r1");
        assert_eq!(json["profileId"], "p1");
        assert_eq!(json["source"]["kind"], "workingTree");
        assert_eq!(json["source"]["staged"], false);
        assert_eq!(json["failed"], 1);
        assert_eq!(json["cancelled"], true);
        assert_eq!(json["startedAt"], 1_700_000_000_000i64);
        assert_eq!(json["elapsedMs"], 9);

        let file = &json["files"][0];
        assert_eq!(file["tokensEstimate"], 4);
        assert_eq!(file["text"]["findings"][0]["severity"], "critical");
        assert_eq!(file["text"]["findings"][0]["line"], 3);
        assert_eq!(file["text"]["markdown"], "生出力");
        assert_eq!(file["text"]["fallbackReason"], "構造化に失敗しました");
        // 失敗は接続テストと同じ形で出せること（画面が文言を出し分けられる）。
        assert_eq!(file["error"]["kind"], "config");
        assert!(file["error"]["message"].is_string());

        // **skill は名前と出どころだけ。本文を webview へ送らない**（CLAUDE.md §4）。
        let skill = &json["skills"][0];
        assert!(skill.get("body").is_none(), "{skill}");
        assert!(skill.get("preview").is_none(), "{skill}");

        // イベントは `kind` で分かれ、**どのファイルのものか**が付いてくる。
        let started = serde_json::to_value(ReviewEvent::Started { total: 3 }).unwrap();
        assert_eq!(started["kind"], "started");
        assert_eq!(started["total"], 3);

        let delta = serde_json::to_value(ReviewEvent::Delta {
            index: 2,
            text: "少しずつ".to_string(),
        })
        .unwrap();
        assert_eq!(delta["kind"], "delta");
        assert_eq!(delta["index"], 2);
        assert_eq!(delta["text"], "少しずつ");

        let done = serde_json::to_value(ReviewEvent::FileDone {
            index: 0,
            result: Box::new(run.files[0].clone()),
        })
        .unwrap();
        assert_eq!(done["kind"], "fileDone");
        assert_eq!(done["result"]["path"], "a.txt");

        let summary = serde_json::to_value(ReviewEvent::SummaryDone {
            summary: Some(text),
        })
        .unwrap();
        assert_eq!(summary["kind"], "summaryDone");
        assert_eq!(summary["summary"]["summary"], "要約");

        // **走りの ID がすべてのイベントに乗る**（中止して次を始めたとき取り違えない）。
        let wrapped = serde_json::to_value(super::ReviewProgressEvent {
            run_id: "r1",
            event: ReviewEvent::SummaryStarted,
        })
        .unwrap();
        assert_eq!(wrapped["runId"], "r1");
        assert_eq!(wrapped["kind"], "summaryStarted");
    }

    /// **ログの状態をフロントがそのまま読めること**（T-24）。
    ///
    /// 書けていないことを画面に出す経路がこれに乗っている。**形がずれると
    /// 「書けているつもり」で黙る**ので、両方の状態を固定する。
    #[test]
    fn the_log_status_wire_format_matches_what_the_front_end_reads() {
        use crate::logging::LogStatus;

        let ok = LogStatus {
            dir: r"C:\Users\tatsu\AppData\Roaming\com.tatsu.gitpeek\logs".to_string(),
            writing: true,
            problem: None,
        };
        let json = serde_json::to_value(&ok).unwrap();
        assert_eq!(json["writing"], true);
        assert_eq!(json["problem"], serde_json::Value::Null);
        assert!(json["dir"].as_str().unwrap().ends_with("logs"));

        let broken = LogStatus {
            dir: String::new(),
            writing: false,
            problem: Some("ログファイルに書けません: 権限がありません".to_string()),
        };
        let json = serde_json::to_value(&broken).unwrap();
        assert_eq!(json["writing"], false);
        assert_eq!(json["dir"], "");
        assert!(json["problem"]
            .as_str()
            .unwrap()
            .starts_with("ログファイルに書けません"));
    }

    /// **保存した結果をフロントがそのまま読めること**（T-23）。
    ///
    /// `StoredReview` は保存の形でもあるので、**書いた JSON がそのまま
    /// 画面の型と一致する**。ここがずれると、履歴が黙って空になる。
    #[test]
    fn the_stored_review_wire_format_matches_what_the_front_end_reads() {
        use crate::git::diff::DiffSource;
        use crate::llm::review::ReviewRun;
        use crate::store::reviews::{ProfileSnapshot, ReviewIndexRow, StoredReview};

        let stored = StoredReview {
            schema_version: 1,
            repository_id: "r1".to_string(),
            saved_at: "2026-09-06T12:04:31+09:00".to_string(),
            file: "20260906T120431-1a2b3c4d.json".to_string(),
            profile: ProfileSnapshot {
                name: "ローカル".to_string(),
                model: "qwen2.5-coder:14b".to_string(),
                base_url: "http://localhost:11434/v1".to_string(),
            },
            run: ReviewRun {
                run_id: "1a2b3c4d".to_string(),
                profile_id: "p1".to_string(),
                model: "qwen2.5-coder:14b".to_string(),
                source: DiffSource::Range {
                    parent: Some("aaa".to_string()),
                    sha: "bbb".to_string(),
                    symmetric: false,
                },
                skills: Vec::new(),
                files: Vec::new(),
                summary: None,
                failed: 0,
                cancelled: false,
                started_at: 1_700_000_000_000,
                elapsed_ms: 9,
            },
        };
        let json = serde_json::to_value(&stored).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["repositoryId"], "r1");
        assert_eq!(json["savedAt"], "2026-09-06T12:04:31+09:00");
        assert_eq!(json["file"], "20260906T120431-1a2b3c4d.json");
        assert_eq!(json["profile"]["baseUrl"], "http://localhost:11434/v1");
        assert_eq!(json["run"]["runId"], "1a2b3c4d");
        assert_eq!(json["run"]["source"]["kind"], "range");

        // **書いたものを読み戻せること。** 履歴を開く経路がこれに乗っている。
        let back: StoredReview = serde_json::from_value(json).expect("読み戻せること");
        assert_eq!(back, stored);

        let row = ReviewIndexRow {
            file: "a.json".to_string(),
            saved_at: "2026-09-06T12:04:31+09:00".to_string(),
            model: "m".to_string(),
            profile_name: "ローカル".to_string(),
            source: Some(DiffSource::WorkingTree { staged: true }),
            files: 3,
            findings: 5,
            failed: 1,
            cancelled: true,
            unreadable: None,
        };
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(json["profileName"], "ローカル");
        assert_eq!(json["source"]["kind"], "workingTree");
        assert_eq!(json["findings"], 5);
        assert_eq!(json["cancelled"], true);
        assert_eq!(json["unreadable"], serde_json::Value::Null);

        // **読めなかった行も同じ形で届く。** 画面から消さないため。
        let broken = ReviewIndexRow {
            file: "b.json".to_string(),
            unreadable: Some("JSON として読めませんでした。".to_string()),
            ..ReviewIndexRow::default()
        };
        let json = serde_json::to_value(&broken).unwrap();
        assert_eq!(json["unreadable"], "JSON として読めませんでした。");
        assert_eq!(json["source"], serde_json::Value::Null);
    }
}
