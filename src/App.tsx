import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { CommandLogPanel } from "./components/commandlog/CommandLogPanel";
import { CommitList } from "./components/commits/CommitList";
import { CommandPalette } from "./components/common/CommandPalette";
import { LoadProgress } from "./components/common/LoadProgress";
import { NoticeBar } from "./components/common/NoticeBar";
import { SplitPane } from "./components/common/SplitPane";
import { RepositoryList, type SortMode } from "./components/sidebar/RepositoryList";
import { Sidebar } from "./components/sidebar/Sidebar";
import { EmptyState } from "./components/setup/EmptyState";
import { GitSetupScreen } from "./components/setup/GitSetupScreen";
import { useCommandLog } from "./hooks/useCommandLog";
import { useTheme, type ThemePreference } from "./hooks/useTheme";
import { ja } from "./i18n/ja";
import {
  detectGit,
  isGitUsable,
  MIN_VERSION_FALLBACK,
  type ColumnWidths,
  type GitStatus,
  type LoadPhase,
  type RepositoryEntry,
} from "./lib/ipc";
import * as repositories from "./store/repositories";
import { useRepositories } from "./store/repositories";
import { dismissSettingsNotice, initSettings, useSettings } from "./store/settings";
import * as snapshots from "./store/snapshot";
import { useSnapshot } from "./store/snapshot";
import {
  DEFAULT_REPOSITORY_UI_STATE,
  initUiState,
  updateRepositoryUiState,
  updateUiState,
  useUiState,
} from "./store/uiState";

/**
 * 進捗バーを出し始めるまでの時間。
 *
 * 数万コミットなら読み込みは 1 秒未満で終わる。そこでバーを出しても
 * 一瞬光って消えるだけで、かえって落ち着かない。
 */
const SLOW_LOAD_MS = 400;

/** サイドバー幅の可動域。狭すぎるとパスが読めず、広すぎると本体が潰れる。 */
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 560;

export default function App() {
  const [theme, setTheme] = useTheme();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [logOpen, setLogOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const entries = useCommandLog();
  const settings = useSettings();
  const { state: uiState } = useUiState();
  const repos = useRepositories();

  const recheck = useCallback(async (path?: string) => {
    setDetecting(true);
    try {
      setStatus(await detectGit(path));
    } catch (error) {
      // バックエンドに到達できない場合も「git を確認できていない」状態として扱う。
      // ここで握らないと status が null のままになり、確認中の表示から戻らなくなる。
      setStatus({
        found: false,
        path: path?.trim() || "git",
        version: null,
        versionOk: false,
        minVersion: MIN_VERSION_FALLBACK,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDetecting(false);
    }
  }, []);

  // StrictMode の二重実行で git を 2 回起動しないようにする。
  const detected = useRef(false);
  useEffect(() => {
    if (detected.current) return;
    detected.current = true;
    void recheck();
  }, [recheck]);

  // 設定 → UI 状態 → リポジトリの順に読む。
  // リポジトリの復元が state.json の lastRepositoryId に依存しているため順序が要る。
  useEffect(() => {
    void (async () => {
      await Promise.all([initSettings(), initUiState()]);
      await repositories.initRepositories();
    })();
  }, []);

  // リポジトリを選んだら全コミットを一括で読む（docs/DESIGN.md §4.1）。
  // 直前のリポジトリの分は Rust 側の LRU に残っているので、戻りは体感即時になる。
  useEffect(() => {
    // 可視 ref はリポジトリごとの設定（settings.json）。切替のたびに読み直す。
    const visible = repositories.selectedRepository()?.visibleRefs;
    void snapshots.load(repos.selectedId, false, false, visible);
  }, [repos.selectedId]);

  // Ctrl+P でリポジトリ切替（docs/DESIGN.md §6.5）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const sortMode = uiState.repositoryListSort;
  const sorted = repositories.sortedEntries(repos.entries, sortMode);
  const selected = sorted.find((entry) => entry.id === repos.selectedId) ?? null;

  const pickFolder = async (title: string): Promise<string | null> => {
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  };

  const handleAdd = async () => {
    const path = await pickFolder(ja.repositories.selectFolder);
    if (path !== null) await repositories.add(path);
  };

  const handleScan = async () => {
    const root = await pickFolder(ja.repositories.selectScanRoot);
    if (root === null) return;
    const added = await repositories.scanAndAdd(root);
    setMessage(added === 0 ? ja.repositories.scanNotFound : ja.repositories.scanFound(added));
  };

  const handleRelocate = async (id: string) => {
    const path = await pickFolder(ja.repositories.selectFolder);
    if (path !== null) await repositories.relocate(id, path);
  };

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__name">{ja.app.name}</span>
        <span className="app__tagline">{ja.app.tagline}</span>
        <div className="app__spacer" />
        <label className="app__theme">
          {ja.theme.label}
          <select
            className="select"
            value={theme}
            onChange={(event) => setTheme(event.target.value as ThemePreference)}
          >
            <option value="system">{ja.theme.system}</option>
            <option value="light">{ja.theme.light}</option>
            <option value="dark">{ja.theme.dark}</option>
          </select>
        </label>
        <button type="button" className="button" onClick={() => setLogOpen((open) => !open)}>
          {logOpen ? ja.commandLog.hide : ja.commandLog.show}
        </button>
      </header>

      {settings.recovered !== null && (
        <NoticeBar
          title={ja.settings.recoveredTitle}
          detail={ja.settings.recoveredDetail(
            settings.recovered.backupPath,
            settings.recovered.reason,
          )}
          onDismiss={dismissSettingsNotice}
        />
      )}
      {settings.error !== null && (
        <NoticeBar
          title={
            settings.errorKind === "save"
              ? ja.settings.saveFailedTitle
              : ja.settings.loadFailedTitle
          }
          detail={settings.error}
          onDismiss={dismissSettingsNotice}
        />
      )}
      {repos.error !== null && (
        <NoticeBar title={repos.error} onDismiss={() => void repositories.refresh()} />
      )}
      {message !== null && <NoticeBar title={message} onDismiss={() => setMessage(null)} />}

      <main className="app__main">
        {status === null ? (
          <p className="app__loading">{ja.setup.detecting}</p>
        ) : isGitUsable(status) ? (
          <SplitPane
            direction="row"
            unit="px"
            size={uiState.paneRatios.sidebarWidth}
            min={SIDEBAR_MIN}
            max={SIDEBAR_MAX}
            onSizeChange={(width) =>
              updateUiState((current) => ({
                ...current,
                paneRatios: { ...current.paneRatios, sidebarWidth: width },
              }))
            }
            first={
              <Sidebar
                repositories={
                  <RepositoryList
                    entries={sorted}
                    selectedId={repos.selectedId}
                    sortMode={sortMode}
                    busy={repos.busy}
                    onSelect={repositories.select}
                    onAdd={() => void handleAdd()}
                    onScan={() => void handleScan()}
                    onRemove={(id) => void repositories.remove(id)}
                    onRelocate={(id) => void handleRelocate(id)}
                    onSortModeChange={(mode: SortMode) =>
                      updateUiState((current) => ({ ...current, repositoryListSort: mode }))
                    }
                    onReorder={(ids) => void repositories.reorder(ids)}
                  />
                }
              />
            }
            second={
              repos.loaded && repos.entries.length === 0 ? (
                <EmptyState
                  busy={repos.busy}
                  onAdd={() => void handleAdd()}
                  onScan={() => void handleScan()}
                />
              ) : (
                <RepositoryPanel entry={selected} />
              )
            }
          />
        ) : (
          <GitSetupScreen
            status={status}
            busy={detecting}
            onRecheck={(path) => void recheck(path)}
          />
        )}
      </main>

      {logOpen && <CommandLogPanel entries={entries} />}

      {paletteOpen && (
        <CommandPalette
          entries={sorted}
          onSelect={(id) => {
            repositories.select(id);
            setPaletteOpen(false);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * 選択中リポジトリの中身。
 *
 * 履歴を読み終えていればコミットリストを、そうでなければ素性と読み込み状態の
 * カードを出す。**下半分は T-11（コミット詳細と差分）まで空**。
 */
function RepositoryPanel({ entry }: { entry: RepositoryEntry | null }) {
  const snapshot = useSnapshot();
  const settings = useSettings();
  const { state: uiState } = useUiState();

  if (entry === null) {
    return <p className="app__loading">{ja.repositories.empty}</p>;
  }

  const data = snapshot.data;
  const layout = snapshot.layout;
  const ready =
    snapshot.repositoryId === entry.id &&
    data !== null &&
    layout !== null &&
    data.commits.length > 0;

  if (!ready || data === null || layout === null) {
    const probe = entry.probe;
    return (
      <div className="ready">
        <div className="ready__card">
          <h1 className="ready__heading">{entry.name}</h1>
          <dl className="ready__facts">
            <dt>{ja.repositories.path}</dt>
            <dd>{entry.path}</dd>
            <dt>{ja.repositories.head}</dt>
            <dd>{describeHead(probe)}</dd>
          </dl>
          {probe?.indexLockPresent === true && (
            <p className="ready__note">{ja.repositories.indexLockDetail}</p>
          )}
        </div>

        <HistoryCard entry={entry} snapshot={snapshot} />
      </div>
    );
  }

  const perRepository = uiState.perRepository[entry.id] ?? DEFAULT_REPOSITORY_UI_STATE;

  const select = (sha: string) => {
    updateRepositoryUiState(entry.id, (current) => ({ ...current, selectedCommit: sha }));
  };
  const setColumns = (columns: ColumnWidths) => {
    updateRepositoryUiState(entry.id, (current) => ({ ...current, columnWidths: columns }));
  };

  return (
    <SplitPane
      direction="column"
      unit="ratio"
      size={uiState.paneRatios.graphDiffSplit}
      min={0.25}
      max={0.95}
      onSizeChange={(ratio) =>
        updateUiState((current) => ({
          ...current,
          paneRatios: { ...current.paneRatios, graphDiffSplit: ratio },
        }))
      }
      first={
        <CommitList
          commits={data.commits}
          layout={layout}
          refs={data.refs}
          head={data.head}
          columns={perRepository.columnWidths}
          dateFormat={settings.settings.ui.dateFormat}
          selectedSha={perRepository.selectedCommit}
          order={snapshot.order}
          onSelect={select}
          onColumnsChange={setColumns}
          onOrderChange={(order) => void snapshots.setOrder(order)}
        />
      }
      second={
        <div className="pending">
          <p>{ja.phase.diffPlaceholder}</p>
        </div>
      }
    />
  );
}

/**
 * 一括取得した履歴の要約。グラフが入るまでの繋ぎであり、
 * 「何件を何 ms で読めたか」を確かめるための場所でもある。
 */
function HistoryCard({
  entry,
  snapshot,
}: {
  entry: RepositoryEntry;
  snapshot: ReturnType<typeof useSnapshot>;
}) {
  // 別のリポジトリの読み込み結果を出さない。
  if (snapshot.repositoryId !== entry.id) return null;

  // 前回が大きすぎたリポジトリは、起動時や切替で黙って読みに行かない。
  // 148 万コミットで数十秒操作できなくなり、プロセスが落ちることもあった。
  if (snapshot.oversized !== null) {
    return (
      <div className="ready__card">
        <h2 className="ready__heading">{ja.snapshot.oversizedTitle}</h2>
        <p>{ja.snapshot.oversizedBody(snapshot.oversized)}</p>
        <p className="ready__note">{ja.snapshot.oversizedNote}</p>
        <button type="button" className="button" onClick={() => void snapshots.loadAnyway()}>
          {ja.snapshot.oversizedLoad}
        </button>
      </div>
    );
  }

  if (snapshot.loading) {
    const progress = snapshot.progress;
    // 短い読み込みでバーが一瞬光るのは邪魔なだけ。しばらくかかってから出す。
    if (progress === null || progress.elapsedMs < SLOW_LOAD_MS) {
      return (
        <div className="ready__card">
          <p className="app__loading">{ja.snapshot.loading}</p>
        </div>
      );
    }
    return (
      <div className="ready__card">
        <LoadProgress
          label={phaseLabel(progress.phase)}
          done={progress.commits}
          total={progress.estimatedTotal}
          elapsedMs={progress.elapsedMs}
        />
      </div>
    );
  }

  if (snapshot.error !== null) {
    return (
      <div className="ready__card">
        <h2 className="ready__heading">{ja.snapshot.failedTitle}</h2>
        <p className="ready__note">{snapshot.error}</p>
        <button type="button" className="button" onClick={() => void snapshots.reload()}>
          {ja.snapshot.reload}
        </button>
      </div>
    );
  }

  const data = snapshot.data;
  if (data === null) return null;

  const local = data.refs.filter((ref) => ref.kind === "localBranch").length;
  const remote = data.refs.filter((ref) => ref.kind === "remoteBranch").length;
  const tags = data.refs.filter((ref) => ref.kind === "tag").length;
  const outOfGraph = data.refs.filter((ref) => ref.outOfGraph).length;

  return (
    <div className="ready__card">
      <dl className="ready__facts">
        <dt>{ja.snapshot.commits}</dt>
        <dd>
          {ja.snapshot.count(data.commits.length)}
          {snapshot.elapsedMs !== null && (
            <span className="ready__aside">{ja.snapshot.elapsed(snapshot.elapsedMs)}</span>
          )}
        </dd>
        <dt>{ja.snapshot.branches}</dt>
        <dd>{ja.snapshot.branchCounts(local, remote)}</dd>
        <dt>{ja.snapshot.tags}</dt>
        <dd>{ja.snapshot.count(tags)}</dd>
        <dt>{ja.snapshot.defaultBranch}</dt>
        <dd>{data.defaultBranch ?? ja.snapshot.none}</dd>
      </dl>
      {data.commits.length === 0 && <p className="ready__note">{ja.snapshot.emptyRepository}</p>}
      {outOfGraph > 0 && <p className="ready__note">{ja.snapshot.outOfGraph(outOfGraph)}</p>}
    </div>
  );
}

function phaseLabel(phase: LoadPhase): string {
  switch (phase) {
    case "refs":
      return ja.snapshot.progressRefs;
    case "commits":
      return ja.snapshot.progressCommits;
    case "graph":
      return ja.snapshot.progressGraph;
    case "transfer":
      return ja.snapshot.progressTransfer;
  }
}

function describeHead(probe: RepositoryEntry["probe"]): string {
  if (probe === null) return ja.repositories.missing;
  if (!probe.isRepository) return probe.error ?? ja.repositories.notRepository;
  switch (probe.head?.kind) {
    case "branch":
      return `${probe.head.name} (${probe.head.sha.slice(0, 7)})`;
    case "detached":
      return `${ja.repositories.detached} (${probe.head.sha.slice(0, 7)})`;
    case "unborn":
      return `${probe.head.name} — ${ja.repositories.unborn}`;
    default:
      return "-";
  }
}
