//! `state.json`（UI 状態）の型と読み書き。
//!
//! 構造は docs/DESIGN.md §12.3 に従う。**アプリが随時上書きするファイルであり、
//! 壊れたら黙って捨てて再生成してよい**（CLAUDE.md §5）。手編集の対象ではないので
//! `settings.json` のような `.bak` 退避はしない。
//!
//! スクロール位置のように高頻度で変わる値を持つため、**書き込みは 300ms デバウンス**する。

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::store::json;
use crate::store::paths::StorePaths;
use crate::store::settings::SCHEMA_VERSION;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UiState {
    pub schema_version: u32,
    /// 起動時に開き直すリポジトリ。パスが消えていたら空状態へ（docs/DESIGN.md §13.1）。
    pub last_repository_id: Option<String>,
    /// 未保存のうちは `None`（tauri.conf.json の既定サイズを使う）。
    pub window_bounds: Option<WindowBounds>,
    pub pane_ratios: PaneRatios,
    /// `"manual"` | `"recent"`
    pub repository_list_sort: String,
    pub per_repository: BTreeMap<String, RepositoryUiState>,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            last_repository_id: None,
            window_bounds: None,
            pane_ratios: PaneRatios::default(),
            repository_list_sort: "manual".to_string(),
            per_repository: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PaneRatios {
    pub sidebar_width: f64,
    /// グラフ（上）と差分本体（下）の分割比。
    pub graph_diff_split: f64,
    /// 右のコミット情報ペイン（詳細 ＋ 変更ファイル一覧）の幅（px）。
    pub commit_info_width: f64,
    pub review_drawer_width: f64,
}

impl Default for PaneRatios {
    fn default() -> Self {
        Self {
            sidebar_width: 260.0,
            graph_diff_split: 0.55,
            commit_info_width: 380.0,
            review_drawer_width: 420.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RepositoryUiState {
    /// 最後に開いた時刻（RFC 3339）。「最終アクセス順」の並べ替えに使う。
    /// 並び順は利便性なので、失っても困らない `state.json` 側に置く。
    pub last_opened_at: Option<String>,
    /// 前回読み込んだコミット数。**進捗の割合表示の分母にするだけ**の概算値。
    /// 分からなくても件数表示に落ちるだけなので、`state.json` 側に置く。
    pub last_commit_count: Option<u64>,
    pub selected_commit: Option<String>,
    /// 2 点比較の**比較元**（T-15）。`None` なら比較していない。
    /// 比較先は `selected_commit`。
    pub compare_commit: Option<String>,
    pub scroll_offset: f64,
    pub selected_file: Option<String>,
    /// ブランチ / タグツリーで**畳んでいる**ノードの ID（T-10）。
    ///
    /// 展開ではなく畳んだ側を持つ。既定が「開いている」なので、この向きなら
    /// 空配列が「すべて既定」を意味し、利用者が全部畳んでも復元できる。
    /// 初期値はタググループだけ（`refTree.ts` の `TAG_GROUP_ID`）。
    pub collapsed_tree_nodes: Vec<String>,
    pub column_widths: ColumnWidths,
}

impl Default for RepositoryUiState {
    fn default() -> Self {
        Self {
            last_opened_at: None,
            last_commit_count: None,
            selected_commit: None,
            compare_commit: None,
            scroll_offset: 0.0,
            selected_file: None,
            // タグは数千本になることがあるので、最初は畳んでおく（docs/DESIGN.md §6.4）。
            collapsed_tree_nodes: vec!["tag".to_string()],
            column_widths: ColumnWidths::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ColumnWidths {
    /// グラフ列。レーン数に上限が無いので、狭いリポジトリでも広いリポジトリでも
    /// ここを引っ張って合わせる（docs/DESIGN.md §5.1-4）。
    pub graph: f64,
    pub subject: f64,
    pub author: f64,
    pub date: f64,
    pub sha: f64,
}

impl Default for ColumnWidths {
    fn default() -> Self {
        Self {
            graph: 200.0,
            subject: 600.0,
            author: 140.0,
            date: 120.0,
            sha: 80.0,
        }
    }
}

/// `state.json` を読む。
///
/// 無い・壊れている・将来版のいずれでも既定値を返し、既定値を書き出す。
/// 失うのはスクロール位置などの利便性だけなので、起動を止めてまで守る価値がない。
/// 書き出しに失敗しても既定値は返す（次のデバウンス書き込みで再試行される）。
pub fn load(paths: &StorePaths) -> UiState {
    let file = paths.state_file();

    let parsed = fs::read_to_string(&file).ok().and_then(|raw| {
        let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
        let found = value.get("schemaVersion").and_then(serde_json::Value::as_u64)?;
        if found > u64::from(SCHEMA_VERSION) {
            return None;
        }
        serde_json::from_value::<UiState>(value).ok()
    });

    match parsed {
        Some(mut state) => {
            state.schema_version = SCHEMA_VERSION;
            state
        }
        None => {
            let state = UiState::default();
            let _ = save(paths, &state);
            state
        }
    }
}

/// `state.json` をアトミックに即時書き込みする。
pub fn save(paths: &StorePaths, state: &UiState) -> Result<(), String> {
    json::write_pretty(&paths.state_file(), state)
}

/// 既定のデバウンス幅。
pub const DEBOUNCE: Duration = Duration::from_millis(300);

/// `state.json` のデバウンス書き込み。
///
/// 最後の `schedule` から `delay` 経過して初めて 1 回だけ書く。スクロールのたびに
/// ディスクへ書きに行かないための仕組み。専用スレッド 1 本で回すので、更新が
/// 何回来てもスレッドは増えない。
pub struct DebouncedWriter {
    inner: Arc<Inner>,
}

struct Inner {
    path: PathBuf,
    delay: Duration,
    pending: Mutex<Pending>,
    ready: Condvar,
}

struct Pending {
    state: Option<UiState>,
    updated_at: Instant,
}

impl DebouncedWriter {
    pub fn new(path: PathBuf, delay: Duration) -> Self {
        let inner = Arc::new(Inner {
            path,
            delay,
            pending: Mutex::new(Pending {
                state: None,
                updated_at: Instant::now(),
            }),
            ready: Condvar::new(),
        });

        let worker = Arc::clone(&inner);
        // 失敗しても致命的ではない（flush で同期書き込みに落ちる）ので結果は捨てる。
        let _ = thread::Builder::new()
            .name("givsoner-state-writer".to_string())
            .spawn(move || worker.run());

        Self { inner }
    }

    /// 書き込みを予約する。直前の予約は上書きされ、タイマーは引き直される。
    pub fn schedule(&self, state: UiState) {
        {
            let mut pending = self.inner.lock_pending();
            pending.state = Some(state);
            pending.updated_at = Instant::now();
        }
        self.inner.ready.notify_all();
    }

    /// 予約が残っていれば即座に書き出す。アプリ終了時に呼ぶ。
    pub fn flush(&self) -> Result<(), String> {
        let state = self.inner.lock_pending().state.take();
        match state {
            Some(state) => json::write_pretty(&self.inner.path, &state),
            None => Ok(()),
        }
    }
}

impl Inner {
    fn lock_pending(&self) -> std::sync::MutexGuard<'_, Pending> {
        self.pending.lock().expect("ui state writer poisoned")
    }

    fn run(&self) {
        loop {
            let state = {
                let mut pending = self.lock_pending();
                loop {
                    if pending.state.is_none() {
                        // 予約が来るまで眠る。flush に先を越された場合もここへ戻る。
                        pending = self.ready.wait(pending).expect("ui state writer poisoned");
                        continue;
                    }
                    let waited = pending.updated_at.elapsed();
                    if waited >= self.delay {
                        break;
                    }
                    // 残り時間だけ待つ。待っている間に schedule が来れば updated_at が
                    // 進むので、そのぶんタイマーが引き直される。
                    let (guard, _) = self
                        .ready
                        .wait_timeout(pending, self.delay - waited)
                        .expect("ui state writer poisoned");
                    pending = guard;
                }
                pending.state.take()
            };

            if let Some(state) = state {
                // 書けなくても次の予約で再試行される。state.json は失っても復元できる。
                let _ = json::write_pretty(&self.path, &state);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{load, save, DebouncedWriter, UiState};
    use crate::store::paths::StorePaths;
    use crate::store::settings::SCHEMA_VERSION;
    use std::time::Duration;

    fn temp_paths() -> (tempfile::TempDir, StorePaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = StorePaths::new(dir.path());
        paths.ensure().unwrap();
        (dir, paths)
    }

    fn state_with(id: &str) -> UiState {
        UiState {
            last_repository_id: Some(id.to_string()),
            ..UiState::default()
        }
    }

    #[test]
    fn creates_defaults_when_missing() {
        let (_dir, paths) = temp_paths();

        let state = load(&paths);
        assert_eq!(state, UiState::default());
        assert_eq!(state.schema_version, SCHEMA_VERSION);
        assert_eq!(state.pane_ratios.sidebar_width, 260.0);
        assert!(paths.state_file().is_file());
    }

    #[test]
    fn round_trips_saved_state() {
        let (_dir, paths) = temp_paths();

        let mut state = state_with("repo-1");
        state.pane_ratios.sidebar_width = 320.0;
        state
            .per_repository
            .insert("repo-1".to_string(), Default::default());
        save(&paths, &state).unwrap();

        assert_eq!(load(&paths), state);
    }

    #[test]
    fn discards_broken_state_without_backup() {
        let (_dir, paths) = temp_paths();
        std::fs::write(paths.state_file(), "{ broken").unwrap();

        assert_eq!(load(&paths), UiState::default());
        assert!(
            !paths.root().join("state.json.bak").exists(),
            "state.json は退避せず捨ててよい"
        );
        // 既定値で書き直されているので、次は素直に読める。
        assert_eq!(load(&paths), UiState::default());
    }

    #[test]
    fn discards_future_schema_version() {
        let (_dir, paths) = temp_paths();
        std::fs::write(
            paths.state_file(),
            r#"{ "schemaVersion": 99, "lastRepositoryId": "repo-1" }"#,
        )
        .unwrap();

        assert_eq!(load(&paths), UiState::default());
    }

    #[test]
    fn debounced_writer_keeps_only_the_last_update() {
        let (_dir, paths) = temp_paths();
        let writer = DebouncedWriter::new(paths.state_file(), Duration::from_millis(40));

        writer.schedule(state_with("first"));
        writer.schedule(state_with("second"));
        assert!(
            !paths.state_file().exists(),
            "デバウンス中は書き込まれていない"
        );

        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(load(&paths).last_repository_id.as_deref(), Some("second"));
    }

    #[test]
    fn flush_writes_immediately() {
        let (_dir, paths) = temp_paths();
        // 待ち時間を長くしても flush なら即座に出る。
        let writer = DebouncedWriter::new(paths.state_file(), Duration::from_secs(30));

        writer.schedule(state_with("repo-1"));
        writer.flush().unwrap();
        assert_eq!(load(&paths).last_repository_id.as_deref(), Some("repo-1"));

        // 予約が無ければ何もしない。
        writer.flush().unwrap();
    }
}
