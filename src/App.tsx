import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { CommandLogPanel } from "./components/commandlog/CommandLogPanel";
import { CommandPalette } from "./components/common/CommandPalette";
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
  type GitStatus,
  type RepositoryEntry,
} from "./lib/ipc";
import * as repositories from "./store/repositories";
import { useRepositories } from "./store/repositories";
import { dismissSettingsNotice, initSettings, useSettings } from "./store/settings";
import { initUiState, updateUiState, useUiState } from "./store/uiState";

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
 * 選択中リポジトリの素性。コミットグラフは Phase 2 でここに入る。
 */
function RepositoryPanel({ entry }: { entry: RepositoryEntry | null }) {
  if (entry === null) {
    return <p className="app__loading">{ja.repositories.empty}</p>;
  }

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
      <div className="ready__card ready__card--muted">
        <h2 className="ready__heading">{ja.phase.title}</h2>
        <p>{ja.phase.body}</p>
        <p className="ready__note">{ja.phase.next}</p>
      </div>
    </div>
  );
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
