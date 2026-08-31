import { useEffect, useRef, useState } from "react";

import { ja } from "../../i18n/ja";
import { CAPACITY } from "./capacity";
import type { CommandLogEntry } from "../../lib/ipc";

type Props = {
  entries: CommandLogEntry[];
};

function formatTime(startedAt: string): string {
  const parsed = new Date(startedAt);
  if (Number.isNaN(parsed.getTime())) return startedAt;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(
    parsed.getSeconds(),
  )}.${pad(parsed.getMilliseconds(), 3)}`;
}

/**
 * git コマンドログパネル。
 *
 * 実行した全コマンド・exit code・stderr・所要時間を時系列で表示する。
 * 固定オプション（`-c core.quotepath=false` 等）も隠さず、既定では畳んで見せる。
 */
export function CommandLogPanel({ entries }: Props) {
  const [showFixedArgs, setShowFixedArgs] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries.length]);

  return (
    <section className="command-log">
      <header className="command-log__header">
        <h2 className="command-log__title">{ja.commandLog.title}</h2>
        <span className="command-log__meta">
          {ja.commandLog.entryCount(entries.length)} / {ja.commandLog.capacity(CAPACITY)}
        </span>
        <label className="command-log__toggle">
          <input
            type="checkbox"
            checked={showFixedArgs}
            onChange={(event) => setShowFixedArgs(event.target.checked)}
          />
          {ja.commandLog.showFixedArgs}
        </label>
      </header>

      <div className="command-log__body" ref={scrollRef}>
        {entries.length === 0 ? (
          <p className="command-log__empty">{ja.commandLog.empty}</p>
        ) : (
          entries.map((entry) => <LogRow key={entry.id} entry={entry} showFixedArgs={showFixedArgs} />)
        )}
      </div>
    </section>
  );
}

function LogRow({
  entry,
  showFixedArgs,
}: {
  entry: CommandLogEntry;
  showFixedArgs: boolean;
}) {
  return (
    <div className={`log-row${entry.ok ? "" : " log-row--failed"}`}>
      <div className="log-row__line">
        <span className="log-row__time">{formatTime(entry.startedAt)}</span>
        <span className="log-row__command">
          <span className="log-row__program">{entry.program}</span>
          {showFixedArgs && entry.fixedArgs.length > 0 && (
            <span className="log-row__fixed"> {entry.fixedArgs.join(" ")}</span>
          )}
          {entry.repo && <span className="log-row__repo"> -C {entry.repo}</span>}
          {entry.args.length > 0 && <span> {entry.args.join(" ")}</span>}
        </span>
        <span className={`log-row__exit${entry.ok ? "" : " log-row__exit--failed"}`}>
          {entry.exitCode === null
            ? ja.commandLog.failedToStart
            : `${ja.commandLog.exit} ${entry.exitCode}`}
        </span>
        <span className="log-row__duration">{entry.durationMs}ms</span>
      </div>
      {entry.stderr.trim() !== "" && (
        <pre className="log-row__stderr">{entry.stderr.trimEnd()}</pre>
      )}
    </div>
  );
}
