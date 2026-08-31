import { useCallback, useEffect, useRef, useState } from "react";

import { CommandLogPanel } from "./components/commandlog/CommandLogPanel";
import { GitSetupScreen } from "./components/setup/GitSetupScreen";
import { useCommandLog } from "./hooks/useCommandLog";
import { useTheme, type ThemePreference } from "./hooks/useTheme";
import { ja } from "./i18n/ja";
import { detectGit, isGitUsable, MIN_VERSION_FALLBACK, type GitStatus } from "./lib/ipc";

export default function App() {
  const [theme, setTheme] = useTheme();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [logOpen, setLogOpen] = useState(true);
  const entries = useCommandLog();

  const recheck = useCallback(async (path?: string) => {
    setBusy(true);
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
      setBusy(false);
    }
  }, []);

  // StrictMode の二重実行で git を 2 回起動しないようにする。
  const detected = useRef(false);
  useEffect(() => {
    if (detected.current) return;
    detected.current = true;
    void recheck();
  }, [recheck]);

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

      <main className="app__main">
        {status === null ? (
          <p className="app__loading">{ja.setup.detecting}</p>
        ) : isGitUsable(status) ? (
          <ReadyView status={status} />
        ) : (
          <GitSetupScreen status={status} busy={busy} onRecheck={(path) => void recheck(path)} />
        )}
      </main>

      {logOpen && <CommandLogPanel entries={entries} />}
    </div>
  );
}

function ReadyView({ status }: { status: GitStatus }) {
  return (
    <div className="ready">
      <div className="ready__card">
        <h1 className="ready__heading">{ja.status.ready}</h1>
        <dl className="ready__facts">
          <dt>{ja.status.version}</dt>
          <dd>{status.version}</dd>
          <dt>{ja.status.path}</dt>
          <dd>{status.path}</dd>
        </dl>
      </div>
      <div className="ready__card ready__card--muted">
        <h2 className="ready__heading">{ja.phase.title}</h2>
        <p>{ja.phase.body}</p>
        <p className="ready__note">{ja.phase.next}</p>
      </div>
    </div>
  );
}
