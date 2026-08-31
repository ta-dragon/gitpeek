import { useEffect, useState } from "react";

import { listCommandLog, onCommandLog, type CommandLogEntry } from "../lib/ipc";

/**
 * git コマンドログを購読する。
 *
 * 初回に既存分をまとめて取得し、以降は `command-log` イベントで追記する。
 * **リポジトリ切替でクリアしない**（docs/DESIGN.md §3.5）。
 */
export function useCommandLog(): CommandLogEntry[] {
  const [entries, setEntries] = useState<CommandLogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    // 購読を先に張ってから既存分を取得し、その間に発生したエントリを取りこぼさない。
    onCommandLog((entry) => {
      if (cancelled) return;
      setEntries((current) =>
        current.some((existing) => existing.id === entry.id)
          ? current
          : [...current, entry],
      );
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        // 購読に失敗しても画面は成立する。
      });

    listCommandLog()
      .then((initial) => {
        if (cancelled) return;
        setEntries((current) => {
          const seen = new Set(current.map((entry) => entry.id));
          const merged = [...initial.filter((entry) => !seen.has(entry.id)), ...current];
          return merged.sort((a, b) => a.id - b.id);
        });
      })
      .catch(() => {
        // 同上。
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return entries;
}
