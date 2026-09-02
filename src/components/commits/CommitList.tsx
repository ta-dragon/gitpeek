/**
 * コミットリスト（docs/DESIGN.md §6.3）。
 *
 * **グラフ列とリスト列は同じスクロールコンテナに置く。** 別コンテナにして
 * `scrollTop` を同期させる作りは、慣性スクロールやトラックパッドで必ずずれる。
 * グラフは行の背後に敷いた 1 枚の SVG で、リストの窓と同じ範囲だけを描く。
 *
 * 仮想スクロールは `@tanstack/react-virtual`。行高は `graphPath.ts` の `ROW_HEIGHT`
 * 固定で、計測はしない（数万行を計測すると開くたびにレイアウトが走る）。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { ContextMenu } from "../common/ContextMenu";
import { CommitGraph } from "../graph/CommitGraph";
import { useCommitNavigation } from "../../hooks/useCommitNavigation";
import { ja } from "../../i18n/ja";
import { graphWidth, ROW_HEIGHT } from "../../lib/graphPath";
import type {
  ColumnWidths,
  CommitMeta,
  GraphOrder,
  HeadInfo,
  LaneLayout,
  RefEntry,
  UiSettings,
} from "../../lib/ipc";
import { CommitRow } from "./CommitRow";
import { groupRefsBySha } from "./RefChips";
import { ScrollbarRefMarkers } from "./ScrollbarRefMarkers";

/** 列幅の下限。これ以上狭めると見出しが読めなくなる。 */
const MIN_COLUMN = 60;

/** 画面外に余分に描く行数。速いスクロールで空白が見えないだけの厚みを持たせる。 */
const OVERSCAN = 12;

/**
 * 列見出しの高さ。**app.css の `--head-height` と一致していなければならない。**
 *
 * 見出しは行と同じスクロールコンテナの中にいる（外に出すと横スクロールでずれる）ので、
 * 行より手前にこのぶんの領域がある。仮想スクロールにも `scrollMargin` として教える。
 */
const HEAD_HEIGHT = 26;

type Props = {
  commits: CommitMeta[];
  layout: LaneLayout;
  refs: RefEntry[];
  head: HeadInfo;
  columns: ColumnWidths;
  dateFormat: UiSettings["dateFormat"];
  selectedSha: string | null;
  order: GraphOrder;
  onSelect: (sha: string) => void;
  onColumnsChange: (next: ColumnWidths) => void;
  onOrderChange: (next: GraphOrder) => void;
};

export function CommitList({
  commits,
  layout,
  refs,
  head,
  columns,
  dateFormat,
  selectedSha,
  order,
  onSelect,
  onColumnsChange,
  onOrderChange,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [jump, setJump] = useState("");
  const [jumpMissed, setJumpMissed] = useState(false);

  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    // 行の手前に見出しがあるぶん。これが無いと行番号と位置が 1 行ぶんずれる。
    scrollMargin: HEAD_HEIGHT,
  });

  const items = virtualizer.getVirtualItems();
  const start = items.length === 0 ? 0 : items[0].index;
  const end = items.length === 0 ? 0 : items[items.length - 1].index + 1;

  const indexBySha = useMemo(() => {
    const map = new Map<string, number>();
    commits.forEach((commit, i) => map.set(commit.sha, i));
    return map;
  }, [commits]);

  const laneBySha = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of layout.rows) map.set(row.sha, row.lane);
    return map;
  }, [layout]);

  const refsBySha = useMemo(() => groupRefsBySha(refs), [refs]);

  /**
   * その行が見えるところまでスクロールする。
   *
   * `scrollToIndex` を使わないのは、上端に寄せたときに **貼り付いた見出しの下に
   * 潜ってしまう**ため。見出しの高さを引いた範囲を可視域として自分で数える。
   */
  const reveal = useCallback((row: number) => {
    const element = scrollRef.current;
    if (element === null) return;
    const top = HEAD_HEIGHT + row * ROW_HEIGHT;
    if (top - HEAD_HEIGHT < element.scrollTop) {
      element.scrollTop = top - HEAD_HEIGHT;
    } else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    }
  }, []);

  const anchorFor = useCallback(
    (row: number) => {
      const element = scrollRef.current;
      if (element === null) return { x: 200, y: 200 };
      const box = element.getBoundingClientRect();
      return {
        x: box.left + 120,
        y: box.top + HEAD_HEIGHT + row * ROW_HEIGHT - element.scrollTop + ROW_HEIGHT,
      };
    },
    [],
  );

  const { choice, closeChoice } = useCommitNavigation({
    commits,
    indexBySha,
    selectedSha,
    headSha: head.sha,
    onSelect,
    onReveal: reveal,
    anchorFor,
    enabled: commits.length > 0,
  });

  /** SHA ジャンプ。前方一致で最初に当たった行へ飛ぶ。 */
  const runJump = () => {
    const needle = jump.trim().toLowerCase();
    if (needle === "") return;
    const row = commits.findIndex(
      (commit) => commit.sha.startsWith(needle) || commit.shortSha.startsWith(needle),
    );
    setJumpMissed(row < 0);
    if (row < 0) return;
    onSelect(commits[row].sha);
    reveal(row);
  };

  const resize = (key: keyof ColumnWidths) => (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = columns[key];

    const move = (moveEvent: PointerEvent) => {
      const next = Math.max(MIN_COLUMN, startWidth + moveEvent.clientX - startX);
      onColumnsChange({ ...columns, [key]: Math.round(next) });
    };
    const up = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  // グラフ列は幅を持つ列として扱う。レーン数に上限が無いので、全部を常に見せようと
  // すると（onyx は 49 レーンあった）本文が画面の外へ押し出される。既定は 200px で、
  // 見出しの取っ手を引けば全レーンまで広げられる（docs/DESIGN.md §5.1-4）。
  const width = Math.min(columns.graph, graphWidth(layout.maxLane));

  return (
    <div className="commits">
      <div className="commits__toolbar">
        <label className="commits__jump">
          {ja.commits.jumpLabel}
          <input
            className="input"
            value={jump}
            placeholder={ja.commits.jumpPlaceholder}
            onChange={(event) => {
              setJump(event.target.value);
              setJumpMissed(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") runJump();
            }}
          />
        </label>
        {jumpMissed && <span className="commits__missed">{ja.commits.jumpNotFound}</span>}

        <div className="app__spacer" />

        {/* date-order は線が交差する（docs/DESIGN.md §4.3）。切替で git log は走らない。 */}
        {order === "date" && <span className="commits__note">{ja.graph.orderDateNote}</span>}
        <label className="commits__order">
          {ja.graph.order}
          <select
            className="select"
            value={order}
            onChange={(event) => onOrderChange(event.target.value as GraphOrder)}
          >
            <option value="topo">{ja.graph.orderTopo}</option>
            <option value="date">{ja.graph.orderDate}</option>
          </select>
        </label>
        <span className="commits__count">{ja.commits.total(commits.length)}</span>
      </div>

      <div className="commits__body">
        <div className="commits__scroll" ref={scrollRef}>
          {/* 見出しは行と同じ横スクロールに乗せる。縦は sticky で貼り付く。 */}
          <div className="commits__head">
            <Header label={ja.commits.graph} width={width} onResize={resize("graph")} />
            <Header
              label={ja.commits.subject}
              width={columns.subject}
              onResize={resize("subject")}
            />
            <Header label={ja.commits.author} width={columns.author} onResize={resize("author")} />
            <Header label={ja.commits.date} width={columns.date} onResize={resize("date")} />
            <Header label={ja.commits.sha} width={columns.sha} onResize={resize("sha")} />
          </div>

          <div className="commits__inner" style={{ height: virtualizer.getTotalSize() }}>
            {/* 行の背後に敷く。行と同じ座標系なので、ずれようがない。 */}
            <CommitGraph
              rows={layout.rows}
              maxLane={layout.maxLane}
              commits={commits}
              start={start}
              end={end}
              headSha={head.sha}
              selectedSha={selectedSha}
              columnWidth={width}
            />

            {items.map((item) => {
              const commit = commits[item.index];
              return (
                <div
                  key={commit.sha}
                  className="commits__row"
                  // `item.start` は scrollMargin 込み。行はその内側に置くので引く。
                  style={{ transform: `translateY(${item.start - HEAD_HEIGHT}px)` }}
                >
                  <CommitRow
                    commit={commit}
                    refs={refsBySha.get(commit.sha) ?? EMPTY_REFS}
                    headBranch={head.branch}
                    detachedHead={head.detached && head.sha === commit.sha}
                    selected={selectedSha === commit.sha}
                    columns={columns}
                    dateFormat={dateFormat}
                    graphWidth={width}
                    onSelect={onSelect}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <ScrollbarRefMarkers
          refs={refs}
          rowIndexBySha={indexBySha}
          laneBySha={laneBySha}
          total={commits.length}
          onJump={reveal}
        />
      </div>

      {choice !== null && (
        <ContextMenu x={choice.x} y={choice.y} items={choice.items} onClose={closeChoice} />
      )}
    </div>
  );
}

/** 参照が毎回変わると `CommitRow` の memo が効かない。 */
const EMPTY_REFS: RefEntry[] = [];

function Header({
  label,
  width,
  onResize,
}: {
  label: string;
  width: number;
  onResize: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div className="commits__col" style={{ width }}>
      <span>{label}</span>
      <div className="commits__grip" onPointerDown={onResize} />
    </div>
  );
}
