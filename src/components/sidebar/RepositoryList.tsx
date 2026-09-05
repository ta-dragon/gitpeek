import { useState } from "react";

import { ja } from "../../i18n/ja";
import type { RepositoryEntry } from "../../lib/ipc";
import { ContextMenu } from "../common/ContextMenu";

export type SortMode = "manual" | "recent";

/**
 * リポジトリ一覧。追加・登録解除・並べ替え・再指定。
 *
 * パスが消えている行はグレーアウトし、「再指定 / 登録解除」を出す（docs/DESIGN.md §3.6）。
 *
 * **fetch の放置警告はアイコンとツールチップだけ**（docs/DESIGN.md §8.3）。
 * モーダルもバナーも出さない。判定は Rust 側（`entry.fetchStale`）に任せてあり、
 * ここで日数を数え直さない。
 */
export function RepositoryList({
  entries,
  selectedId,
  sortMode,
  busy,
  onSelect,
  onAdd,
  onScan,
  onRemove,
  onRelocate,
  onSortModeChange,
  onReorder,
  onFetch,
  onFetchAll,
  onClone,
}: {
  entries: RepositoryEntry[];
  selectedId: string | null;
  sortMode: SortMode;
  busy: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onScan: () => void;
  onRemove: (id: string) => void;
  onRelocate: (id: string) => void;
  onSortModeChange: (mode: SortMode) => void;
  onReorder: (orderedIds: string[]) => void;
  onFetch: (id: string) => void;
  /** 一括。**確認ダイアログは呼び出し側が出す**（docs/DESIGN.md §8.3）。 */
  onFetchAll: () => void;
  /** URL から clone（T-19）。**空状態からも押せること**（`EmptyState`）。 */
  onClone: () => void;
}) {
  // 一括 fetch の相手はリモートを持つ登録だけ。**1 つも無ければボタンを押させない**
  // （押せるのに何も起きないボタンになる）。
  const fetchable = entries.some((entry) => (entry.probe?.remotes.length ?? 0) > 0);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  // 「最終アクセス順」表示中は手動並べ替えを受け付けない（順序の意味が二重になるため）。
  const draggable = sortMode === "manual" && !busy;

  const endDrag = () => {
    setDraggingId(null);
    setDropTarget(null);
  };

  /** 行の上半分なら手前、下半分なら後ろへ落とす。線が出た位置にそのまま入る。 */
  const handleDragOver = (event: React.DragEvent<HTMLLIElement>, targetId: string) => {
    if (!draggable || draggingId === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const box = event.currentTarget.getBoundingClientRect();
    setDropTarget({ id: targetId, after: event.clientY > box.top + box.height / 2 });
  };

  const handleDrop = (targetId: string) => {
    const target = dropTarget?.id === targetId ? dropTarget : null;
    if (draggingId === null || target === null) {
      endDrag();
      return;
    }

    // 動かす 1 件を抜いてから、線の位置へ入れ直す。
    const ids = entries.map((entry) => entry.id).filter((id) => id !== draggingId);
    const index = ids.indexOf(targetId);
    if (index < 0) {
      endDrag();
      return;
    }
    ids.splice(index + (target.after ? 1 : 0), 0, draggingId);
    onReorder(ids);
    endDrag();
  };

  return (
    <section className="repos">
      <header className="repos__header">
        <span className="repos__title">{ja.repositories.title}</span>
        <span className="repos__count">{entries.length}</span>
        <div className="app__spacer" />
        <button type="button" className="button button--small" onClick={onAdd} disabled={busy}>
          {ja.repositories.addShort}
        </button>
        <button type="button" className="button button--small" onClick={onScan} disabled={busy}>
          {ja.repositories.scanShort}
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={onClone}
          disabled={busy}
          title={ja.repositories.cloneHint}
        >
          {ja.repositories.cloneShort}
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={onFetchAll}
          disabled={busy || !fetchable}
          title={fetchable ? ja.repositories.fetchAllHint : ja.fetch.noRepositories}
        >
          {ja.repositories.fetchAll}
        </button>
      </header>

      <div className="repos__sort">
        <label className="repos__sortLabel">
          {ja.repositories.sortLabel}
          <select
            className="select select--small"
            value={sortMode}
            onChange={(event) => onSortModeChange(event.target.value as SortMode)}
          >
            <option value="manual">{ja.repositories.sortManual}</option>
            <option value="recent">{ja.repositories.sortRecent}</option>
          </select>
        </label>
        <span className="repos__hint">
          {draggable
            ? `${ja.repositories.dragHint} / ${ja.repositories.contextHint}`
            : ja.repositories.contextHint}
        </span>
      </div>

      {entries.length === 0 ? (
        <p className="repos__empty">{ja.repositories.empty}</p>
      ) : (
        <ul className="repos__list">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className={dropLineClass(dropTarget, entry.id)}
              // dragstart は掴み手から上がってくる。行全体を draggable にしても、
              // 起点が <button> だとブラウザがドラッグを開始しない。
              onDragStart={(event) => {
                setDraggingId(entry.id);
                event.dataTransfer.effectAllowed = "move";
                // 値を入れないとドラッグを開始しないブラウザがある。
                event.dataTransfer.setData("text/plain", entry.id);
              }}
              onDragEnd={endDrag}
              onDragOver={(event) => handleDragOver(event, entry.id)}
              onDrop={(event) => {
                event.preventDefault();
                handleDrop(entry.id);
              }}
              // 右クリックで「再指定 / 登録解除」。正常な行からも解除できる唯一の導線。
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ id: entry.id, x: event.clientX, y: event.clientY });
              }}
            >
              <RepositoryRow
                entry={entry}
                selected={entry.id === selectedId}
                dragging={entry.id === draggingId}
                draggable={draggable}
                busy={busy}
                onSelect={onSelect}
                onRemove={onRemove}
                onRelocate={onRelocate}
              />
            </li>
          ))}
        </ul>
      )}

      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: ja.repositories.fetch,
              title: ja.repositories.fetchHint,
              // リモートが無いリポジトリでは意味が無いので出さない。
              disabled: busy || !hasRemotes(entries, menu.id),
              onSelect: () => onFetch(menu.id),
            },
            {
              label: ja.repositories.relocate,
              title: ja.repositories.relocateHint,
              disabled: busy,
              onSelect: () => onRelocate(menu.id),
            },
            {
              label: ja.repositories.remove,
              title: ja.repositories.removeHint,
              danger: true,
              disabled: busy,
              onSelect: () => onRemove(menu.id),
            },
          ]}
        />
      )}
    </section>
  );
}

function RepositoryRow({
  entry,
  selected,
  dragging,
  draggable,
  busy,
  onSelect,
  onRemove,
  onRelocate,
}: {
  entry: RepositoryEntry;
  selected: boolean;
  dragging: boolean;
  draggable: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onRelocate: (id: string) => void;
}) {
  const missing = entry.probe === null;
  const notRepository = entry.probe !== null && !entry.probe.isRepository;

  return (
    <div
      className={[
        "repo",
        selected ? "repo--selected" : "",
        missing || notRepository ? "repo--missing" : "",
        dragging ? "repo--dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="repo__head">
        {/* 掴み手。行全体を draggable にしても、<button> の上から掴むと
            ブラウザがドラッグを開始しないため、専用の起点を置く。 */}
        <span
          className="repo__grip"
          draggable={draggable}
          aria-hidden="true"
          title={draggable ? ja.repositories.dragHint : ja.repositories.dragDisabled}
        >
          ⠿
        </span>
        <button
          type="button"
          className="repo__main"
          onClick={() => onSelect(entry.id)}
          disabled={missing}
          title={entry.path}
        >
          <span className="repo__name">{entry.name}</span>
          <span className="repo__path">{elideMiddle(entry.path, 44)}</span>
        </button>
      </div>

      <div className="repo__marks">
        {/* ahead/behind の場所を確保しておく（T-17 で ref の更新までは入った）。 */}
        <span className="repo__badges">{entry.probe && <ProbeBadges entry={entry} />}</span>
      </div>

      {(missing || notRepository) && (
        <div className="repo__recover">
          <span className="repo__warning">
            {missing ? ja.repositories.missing : ja.repositories.notRepository}
          </span>
          <button
            type="button"
            className="button button--small"
            onClick={() => onRelocate(entry.id)}
            disabled={busy}
          >
            {ja.repositories.relocate}
          </button>
          <button
            type="button"
            className="button button--small"
            onClick={() => onRemove(entry.id)}
            disabled={busy}
          >
            {ja.repositories.remove}
          </button>
        </div>
      )}
    </div>
  );
}

function ProbeBadges({ entry }: { entry: RepositoryEntry }) {
  const probe = entry.probe;
  if (probe === null || !probe.isRepository) return null;

  return (
    <>
      {/* 放置警告。**アイコンとツールチップだけ**（docs/DESIGN.md §8.3）。 */}
      {entry.fetchStale && (
        <span
          className="repo__stale"
          title={ja.repositories.staleHint(daysSince(probe.lastFetchAtMs))}
        >
          {ja.repositories.stale}
        </span>
      )}
      {probe.isBare && <span className="badge">{ja.repositories.bare}</span>}
      {probe.isShallow && <span className="badge">{ja.repositories.shallow}</span>}
      {probe.head?.kind === "detached" && (
        <span className="badge">{ja.repositories.detached}</span>
      )}
      {probe.head?.kind === "unborn" && <span className="badge">{ja.repositories.unborn}</span>}
      {probe.indexLockPresent && (
        <span className="badge badge--warning" title={ja.repositories.indexLockDetail}>
          {ja.repositories.indexLock}
        </span>
      )}
    </>
  );
}

/** リモートを持っているか。持っていなければ fetch のメニューを出さない。 */
function hasRemotes(entries: RepositoryEntry[], id: string): boolean {
  const entry = entries.find((candidate) => candidate.id === id);
  return (entry?.probe?.remotes.length ?? 0) > 0;
}

/** ツールチップに出す日数。一度も fetch していなければ null。 */
function daysSince(lastFetchAtMs: number | null): number | null {
  if (lastFetchAtMs === null) return null;
  return Math.floor((Date.now() - lastFetchAtMs) / (24 * 60 * 60 * 1000));
}

/** ドロップ位置を示す線をどちら側に引くか。 */
function dropLineClass(
  dropTarget: { id: string; after: boolean } | null,
  id: string,
): string | undefined {
  if (dropTarget === null || dropTarget.id !== id) return undefined;
  return dropTarget.after ? "repos__row--dropAfter" : "repos__row--dropBefore";
}

/** 長いパスは中間を省略する。末尾（リポジトリ名）が見えることが大事。 */
function elideMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
