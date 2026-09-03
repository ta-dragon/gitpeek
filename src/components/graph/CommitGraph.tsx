/**
 * コミットグラフの SVG 描画。
 *
 * 計算はすべて Rust 側（レーン番号）と `src/lib/graphPath.ts`（座標とパス）が済ませてある。
 * ここがやるのは並べることだけで、**幾何や配色の判断をこのファイルに書かない**
 * （テストできなくなる — docs/DESIGN.md §14.4）。
 *
 * **リストの仮想スクロールと同じ窓だけを描く。** 全行を 1 枚の SVG にすると、数万行では
 * DOM が数十万ノードになり、要素の高さもブラウザの上限（約 3,300 万 px）に近づく。
 */
import { useMemo } from "react";

import {
  edgePath,
  graphWidth,
  laneColor,
  laneX,
  NODE_RADIUS,
  RING_RADIUS,
  rootCapPath,
  ROW_HEIGHT,
  rowY,
  type GraphRow,
} from "../../lib/graphPath";
import type { CommitMeta } from "../../lib/ipc";

type Props = {
  rows: GraphRow[];
  maxLane: number;
  commits: CommitMeta[];
  /** 描く範囲（行番号）。リスト側の仮想スクロールが決める。 */
  start: number;
  end: number;
  headSha: string | null;
  selectedSha: string | null;
  /** グラフ列の幅。これより右のレーンは見えない（列を広げれば出る）。 */
  columnWidth: number;
};

export function CommitGraph({
  rows,
  maxLane,
  commits,
  start,
  end,
  headSha,
  selectedSha,
  columnWidth,
}: Props) {
  const width = graphWidth(maxLane);

  // **窓の上から入ってくる辺も描く。** 窓の中の行が持つ辺だけを描くと、上から
  // 下りてきている線が窓の上端で消え、ノードだけが浮く。`row.passing` で縦線を
  // 引き直す手もあるが、辺が曲がった後にも縦線が残って切れ端になる（T-06 の不具合）。
  //
  // 走査は毎回全行を舐める。20,285 コミットの末尾で 1 回 0.45ms（実測）なので、
  // v1 の想定規模（docs/DESIGN.md §4.1）では索引を用意するまでもない。
  const paths = useMemo(() => {
    const found: { key: string; d: string; lane: number }[] = [];

    for (let row = 0; row < rows.length; row += 1) {
      if (row >= end) break;
      const source = rows[row];

      for (let nth = 0; nth < source.edges.length; nth += 1) {
        const edge = source.edges[nth];
        const target = indexOf(rows, edge.parentSha);
        // 親が見つからない辺は下端まで引く。描かずに落とすと線が途中で切れる。
        const to = target === -1 ? rows.length : target;
        if (to < start) continue;

        // 窓の外まで伸びる辺は、窓の縁で切る。曲がりの形は変えない。
        const clipped = Math.min(to, end);
        const targetLane = clipped === to && target !== -1 ? rows[to].lane : edge.toLane;
        found.push({
          key: `${row}-${nth}`,
          d: edgePath(edge, row, clipped, targetLane),
          lane: edge.toLane,
        });
      }
    }
    return found;
  }, [rows, start, end]);

  const bySha = useMemo(() => {
    const map = new Map<string, CommitMeta>();
    for (const commit of commits) map.set(commit.sha, commit);
    return map;
  }, [commits]);

  const top = start * ROW_HEIGHT;
  const height = (end - start) * ROW_HEIGHT;

  return (
    // 列の幅で切る。SVG 自体は全レーンぶんの幅を持ったままにして、列を広げれば見える。
    <div className="graph__clip" style={{ top, width: columnWidth, height }}>
    <svg
      className="graph__svg"
      width={width}
      height={height}
      // 行番号そのままの座標で描けるよう、窓の位置を viewBox でずらす。
      viewBox={`0 ${top} ${width} ${height}`}
      role="presentation"
      aria-hidden="true"
    >
      <g className="graph__edges">
        {paths.map((path) => (
          // 色は「その辺が走るレーン」に合わせる。合流でも枝の色が保たれる。
          <path key={path.key} className="graph__line" d={path.d} stroke={laneColor(path.lane)} />
        ))}
      </g>

      <g className="graph__nodes">
        {rows.slice(start, end).map((row, offset) => {
          const index = start + offset;
          const commit = bySha.get(row.sha);
          const merge = (commit?.parents.length ?? 0) > 1;
          // ルートは線がその場で止まる唯一の終わり方なので、終端の印を足す（T-27）。
          const root = commit !== undefined && commit.parents.length === 0;
          const color = laneColor(row.lane);
          return (
            <g key={row.sha}>
              {root && <path className="graph__cap" d={rootCapPath(row.lane, index)} stroke={color} />}
              <g transform={`translate(${laneX(row.lane)} ${rowY(index)})`}>
              {row.sha === selectedSha && (
                <circle className="graph__selected" r={RING_RADIUS} fill={color} />
              )}
              {row.sha === headSha && (
                <circle className="graph__ring" r={RING_RADIUS} stroke={color} />
              )}
              <circle
                className="graph__dot"
                r={NODE_RADIUS}
                stroke={color}
                fill={merge ? "var(--graph-node-fill)" : color}
              />
              </g>
            </g>
          );
        })}
      </g>
    </svg>
    </div>
  );
}

/**
 * SHA の行番号。見つからなければ -1。
 *
 * 呼び出しごとに `Map` を作ると窓を動かすたびに数万件を積み直すことになるので、
 * レイアウトに 1 つだけ持たせて使い回す。
 */
const indexes = new WeakMap<GraphRow[], Map<string, number>>();

function indexOf(rows: GraphRow[], sha: string): number {
  let index = indexes.get(rows);
  if (index === undefined) {
    index = new Map<string, number>();
    rows.forEach((row, i) => index?.set(row.sha, i));
    indexes.set(rows, index);
  }
  return index.get(sha) ?? -1;
}
