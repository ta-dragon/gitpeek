import { useEffect, useMemo, useRef, useState } from "react";

import { ja } from "../../i18n/ja";
import type { RepositoryEntry } from "../../lib/ipc";

/**
 * `Ctrl+P` のリポジトリ絞り込み（docs/DESIGN.md §6.5）。
 *
 * 名前とパスの部分一致。`↑↓` で選択、`Enter` で開く、`Esc` で閉じる。
 */
export function CommandPalette({
  entries,
  onSelect,
  onClose,
}: {
  entries: RepositoryEntry[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return entries;
    return entries.filter(
      (entry) =>
        entry.name.toLowerCase().includes(needle) ||
        entry.path.toLowerCase().includes(needle),
    );
  }, [entries, query]);

  // 絞り込みが変わったら選択位置を先頭へ戻す。空振りしても範囲外にしない。
  const active = matches.length === 0 ? -1 : Math.min(activeIndex, matches.length - 1);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matches.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => {
        const next = (Math.min(current, matches.length - 1) + delta + matches.length) % matches.length;
        return next;
      });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const entry = matches[active];
      if (entry) onSelect(entry.id);
    }
  };

  return (
    <div className="palette__backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          className="input palette__input"
          type="text"
          value={query}
          placeholder={ja.palette.placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
        />
        <ul className="palette__list">
          {matches.length === 0 ? (
            <li className="palette__empty">{ja.palette.empty}</li>
          ) : (
            matches.map((entry, index) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={`palette__item${index === active ? " palette__item--active" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => onSelect(entry.id)}
                >
                  <span className="palette__name">{entry.name}</span>
                  <span className="palette__path">{entry.path}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="palette__hint">{ja.palette.hint}</div>
      </div>
    </div>
  );
}
