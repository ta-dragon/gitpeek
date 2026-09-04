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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { ContextMenu, type ContextMenuItem } from "../common/ContextMenu";
import { CommitGraph } from "../graph/CommitGraph";
import type { WorkingSummary } from "../../lib/workingTree";
import { WorkingTreeRow } from "./WorkingTreeRow";
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
  /** 読み込んだ全コミット。**並べる順と件数を決めるのは `layout.rows`。** */
  commits: CommitMeta[];
  layout: LaneLayout;
  refs: RefEntry[];
  head: HeadInfo;
  columns: ColumnWidths;
  dateFormat: UiSettings["dateFormat"];
  selectedSha: string | null;
  /** 2 点比較の比較元。`null` なら比較していない（T-15）。 */
  compareSha: string | null;
  /**
   * 作業ツリーの擬似行（T-16。docs/DESIGN.md §7.5）。
   * **クリーンなときは `null`** を渡して行ごと出さない。
   */
  worktree: {
    summary: WorkingSummary;
    selected: boolean;
    onSelect: () => void;
  } | null;
  /**
   * 外から「この SHA を見せてほしい」と言われたとき（ブランチツリーのジャンプ）。
   * 連番が変わったときだけ動く。選択そのものは `selectedSha` が正。
   */
  jumpTo: { sha: string; nonce: number } | null;
  order: GraphOrder;
  onSelect: (sha: string, compare: boolean) => void;
  /** 行の右クリックから checkout の確認を出す（T-18。docs/DESIGN.md §8.1）。 */
  onCheckoutCommit: (sha: string) => void;
  /** 短い通知（コピーの結果）。 */
  onNotice: (message: string) => void;
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
  compareSha,
  worktree,
  jumpTo,
  order,
  onSelect,
  onCheckoutCommit,
  onNotice,
  onColumnsChange,
  onOrderChange,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [jump, setJump] = useState("");
  const [jumpMissed, setJumpMissed] = useState(false);
  /** 行の右クリックメニュー（T-18）。親・子の選択メニューとは別に持つ。 */
  const [rowMenu, setRowMenu] = useState<{ sha: string; x: number; y: number } | null>(null);

  /**
   * 実際に並べるコミット。**`layout.rows` が正**で、`commits` はその材料。
   *
   * レーンは可視 ref で絞られ、並び順（topo / date）でも組み替わる。行の文字を
   * `commits` の添字で引くと、**絞り込みや date 表示でグラフと 1 行ずつずれる**。
   * どちらの経路でも `rows` に合わせる。
   */
  const shown = useMemo(() => {
    const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
    const list: CommitMeta[] = [];
    for (const row of layout.rows) {
      const commit = bySha.get(row.sha);
      if (commit !== undefined) list.push(commit);
    }
    return list;
  }, [commits, layout]);

  /**
   * 擬似行のぶん。**レーン計算の対象外**なので `layout.rows` には無い（CLAUDE.md §3-6）。
   * 行番号はこのぶんだけずれるので、グラフ側は `rowOffset` で下げて描く。
   */
  const extra = worktree === null ? 0 : 1;

  const virtualizer = useVirtualizer({
    count: shown.length + extra,
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
    shown.forEach((commit, i) => map.set(commit.sha, i));
    return map;
  }, [shown]);

  const laneBySha = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of layout.rows) map.set(row.sha, row.lane);
    return map;
  }, [layout]);

  const refsBySha = useMemo(() => groupRefsBySha(refs), [refs]);

  /**
   * 擬似行のノードを置くレーンと、HEAD へ点線を引いてよいか。
   *
   * **点線を引くのは HEAD が真下にあるときだけ。** 途中に別のコミットが挟まると、
   * 線がどこへ向かっているのか分からなくなる（DESIGN.md §7.5）。
   */
  const headLane = head.sha === null ? 0 : (laneBySha.get(head.sha) ?? 0);
  const connectedToHead = head.sha !== null && shown[0]?.sha === head.sha;

  /**
   * その行が見えるところまでスクロールする。
   *
   * `scrollToIndex` を使わないのは、上端に寄せたときに **貼り付いた見出しの下に
   * 潜ってしまう**ため。見出しの高さを引いた範囲を可視域として自分で数える。
   */
  const reveal = useCallback(
    (row: number) => {
    const element = scrollRef.current;
    if (element === null) return;
    // 行番号はコミットの並びのもの。擬似行のぶん下へずれている。
    const top = HEAD_HEIGHT + (row + extra) * ROW_HEIGHT;
    if (top - HEAD_HEIGHT < element.scrollTop) {
      element.scrollTop = top - HEAD_HEIGHT;
    } else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    }
    },
    [extra],
  );

  const anchorFor = useCallback(
    (row: number) => {
      const element = scrollRef.current;
      if (element === null) return { x: 200, y: 200 };
      const box = element.getBoundingClientRect();
      return {
        x: box.left + 120,
        y:
          box.top + HEAD_HEIGHT + (row + extra) * ROW_HEIGHT - element.scrollTop + ROW_HEIGHT,
      };
    },
    [extra],
  );

  /** ジャンプとキーボード操作は**常に 1 点選択**（比較は Ctrl+クリックだけ）。 */
  const selectOnly = useCallback((sha: string) => onSelect(sha, false), [onSelect]);

  // ブランチツリーからのジャンプ。処理済みの連番を覚えておき、再描画では動かない。
  const handledJump = useRef(0);
  useEffect(() => {
    if (jumpTo === null || jumpTo.nonce === handledJump.current) return;
    handledJump.current = jumpTo.nonce;
    const row = indexBySha.get(jumpTo.sha);
    if (row === undefined) return;
    selectOnly(jumpTo.sha);
    reveal(row);
  }, [jumpTo, indexBySha, selectOnly, reveal]);

  const { choice, closeChoice } = useCommitNavigation({
    commits: shown,
    indexBySha,
    selectedSha,
    headSha: head.sha,
    onSelect: selectOnly,
    onReveal: reveal,
    anchorFor,
    enabled: shown.length > 0,
  });

  /** SHA ジャンプ。前方一致で最初に当たった行へ飛ぶ。 */
  const runJump = () => {
    const needle = jump.trim().toLowerCase();
    if (needle === "") return;
    const row = shown.findIndex(
      (commit) => commit.sha.startsWith(needle) || commit.shortSha.startsWith(needle),
    );
    setJumpMissed(row < 0);
    if (row < 0) return;
    selectOnly(shown[row].sha);
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

        {/* 2 点比較は操作が見えないので、比較していないときだけ出す（T-15）。 */}
        {compareSha === null && <span className="commits__note">{ja.compare.hint}</span>}

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
        <span className="commits__count">{ja.commits.total(shown.length)}</span>
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
              commits={shown}
              start={Math.max(0, start - extra)}
              end={Math.max(0, end - extra)}
              rowOffset={extra}
              headSha={head.sha}
              selectedSha={selectedSha}
              columnWidth={width}
            />

            {items.map((item) => {
              // 擬似行は最上部の 1 行だけ。**コミットではない**ので別に描く。
              if (worktree !== null && item.index === 0) {
                return (
                  <div
                    key="worktree"
                    className="commits__row"
                    style={{ transform: `translateY(${item.start - HEAD_HEIGHT}px)` }}
                  >
                    <WorkingTreeRow
                      summary={worktree.summary}
                      selected={worktree.selected}
                      columns={columns}
                      graphWidth={width}
                      headLane={headLane}
                      connected={connectedToHead}
                      onSelect={worktree.onSelect}
                    />
                  </div>
                );
              }

              const commit = shown[item.index - extra];
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
                    compareFrom={compareSha === commit.sha}
                    columns={columns}
                    dateFormat={dateFormat}
                    graphWidth={width}
                    onSelect={onSelect}
                    onContextMenu={(sha, x, y) => setRowMenu({ sha, x, y })}
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
          total={shown.length}
          onJump={reveal}
        />
      </div>

      {choice !== null && (
        <ContextMenu x={choice.x} y={choice.y} items={choice.items} onClose={closeChoice} />
      )}

      {rowMenu !== null && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          items={rowMenuItems(
            shown.find((commit) => commit.sha === rowMenu.sha) ?? null,
            onCheckoutCommit,
            onNotice,
          )}
          onClose={() => setRowMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * 行の右クリックメニュー（T-18。docs/DESIGN.md §8.1）。
 *
 * **コミットへの checkout は必ず detached。** ここからブランチを作る経路は置かない
 * （ブランチを作るのはリモート追跡ブランチの checkout だけ — CLAUDE.md §1）。
 */
function rowMenuItems(
  commit: CommitMeta | null,
  onCheckoutCommit: (sha: string) => void,
  onNotice: (message: string) => void,
): ContextMenuItem[] {
  if (commit === null) return [];
  return [
    {
      label: ja.commits.checkoutHere,
      onSelect: () => onCheckoutCommit(commit.sha),
    },
    {
      label: ja.commits.copySha,
      onSelect: () => void copyText(commit.sha, onNotice),
    },
    {
      label: ja.commits.copySubject,
      onSelect: () => void copyText(commit.subject, onNotice),
    },
  ];
}

/** クリップボードへ書く。**失敗したら黙らず通知する**（`RefTree` と同じ扱い）。 */
async function copyText(text: string, onNotice: (message: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    onNotice(ja.commits.copied(text));
  } catch {
    onNotice(ja.commits.copyFailed);
  }
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
