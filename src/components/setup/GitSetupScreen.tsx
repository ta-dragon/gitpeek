import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { ja } from "../../i18n/ja";
import type { GitStatus } from "../../lib/ipc";

type Props = {
  status: GitStatus;
  busy: boolean;
  onRecheck: (path: string) => void;
};

function titleFor(status: GitStatus): string {
  if (!status.found) return ja.setup.notFoundTitle;
  if (status.version === null) return ja.setup.unreadableTitle;
  return ja.setup.tooOldTitle;
}

function bodyFor(status: GitStatus): string {
  if (!status.found) return ja.setup.notFoundBody;
  if (status.version === null) return ja.setup.notFoundBody;
  return ja.setup.tooOldBody(status.version, status.minVersion);
}

/**
 * git が使えないときの導線（docs/DESIGN.md §3.4 / §13.1）。
 * インストーラへのリンク、フルパスの手動指定、再チェックを提供する。
 */
export function GitSetupScreen({ status, busy, onRecheck }: Props) {
  const [path, setPath] = useState(status.found ? status.path : "");

  return (
    <div className="setup">
      <div className="setup__card">
        <h1 className="setup__title">{titleFor(status)}</h1>
        <p className="setup__body">{bodyFor(status)}</p>

        {status.error && (
          <details className="setup__error">
            <summary>{ja.setup.errorLabel}</summary>
            <pre>{status.error}</pre>
          </details>
        )}

        <div className="setup__install">
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              void openUrl(ja.setup.installUrl).catch(() => {
                // 開けなくても下に URL を出しているので詰まらない。
              });
            }}
          >
            {ja.setup.installLabel}
          </button>
          <code className="setup__url">{ja.setup.installUrl}</code>
          <p className="setup__hint">{ja.setup.installUrlHint}</p>
        </div>

        <form
          className="setup__form"
          onSubmit={(event) => {
            event.preventDefault();
            onRecheck(path);
          }}
        >
          <label className="setup__label" htmlFor="git-path">
            {ja.setup.pathLabel}
          </label>
          <div className="setup__row">
            <input
              id="git-path"
              className="input"
              type="text"
              value={path}
              spellCheck={false}
              placeholder={ja.setup.pathPlaceholder}
              onChange={(event) => setPath(event.target.value)}
            />
            <button type="submit" className="button" disabled={busy}>
              {busy ? ja.setup.rechecking : ja.setup.recheck}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
