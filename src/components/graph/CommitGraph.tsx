/**
 * コミットグラフの SVG 描画。
 *
 * 計算はすべて Rust 側（レーン番号）と `src/lib/graphPath.ts`（座標とパス）が済ませてある。
 * ここがやるのは並べることだけで、**幾何や配色の判断をこのファイルに書かない**
 * （テストできなくなる — docs/DESIGN.md §14.4）。
 *
 * 仮想スクロールとリスト列は T-07。ここでは行数を [`MAX_ROWS`] で頭打ちにしている。
 */
import { useMemo } from "react";

import { ja } from "../../i18n/ja";
import {
  edgePath,
  graphWidth,
  laneColor,
  laneX,
  NODE_RADIUS,
  passingPath,
  RING_RADIUS,
  ROW_HEIGHT,
  rowIndexBySha,
  rowY,
  type GraphRow,
} from "../../lib/graphPath";
import type { CommitMeta } from "../../lib/ipc";

/**
 * 一度に描く行数の上限。
 *
 * 仮想スクロールが入るまでの仮の蓋（T-07 で外す）。数万行を素の SVG に流すと
 * DOM が数十万ノードになり、目視どころではなくなる。
 */
export const MAX_ROWS = 400;

type Props = {
  rows: GraphRow[];
  maxLane: number;
  /** 行の副次情報。ノードのツールチップと、マージかどうかの判定に使う。 */
  commits: CommitMeta[];
  /** HEAD が指すコミット。リングを付ける。 */
  headSha: string | null;
  selectedSha: string | null;
  onSelect: (sha: string) => void;
};

export function CommitGraph({
  rows,
  maxLane,
  commits,
  headSha,
  selectedSha,
  onSelect,
}: Props) {
  // 辺の行き先は SHA でしか分からない。行ごとに探すと数万行で効くので 1 度だけ作る。
  const rowIndex = useMemo(() => rowIndexBySha(rows), [rows]);
  const bySha = useMemo(() => {
    const map = new Map<string, CommitMeta>();
    for (const commit of commits) map.set(commit.sha, commit);
    return map;
  }, [commits]);

  const visible = rows.slice(0, MAX_ROWS);
  const width = graphWidth(maxLane);
  const height = visible.length * ROW_HEIGHT;

  return (
    <div className="graph">
      <div className="graph__scroll">
        <svg
          className="graph__svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="presentation"
        >
          {/* 線を先に全部描いてからノードを置く。ノードが線に隠れないように。 */}
          <g className="graph__edges">
            {visible.map((row, index) => (
              <g key={row.sha}>
                {row.passing.map((lane) => (
                  <path
                    key={`p${lane}`}
                    className="graph__line"
                    d={passingPath(lane, index)}
                    stroke={laneColor(lane)}
                  />
                ))}
                {row.edges.map((edge, nth) => {
                  const target = rowIndex.get(edge.parentSha);
                  // **親が表示範囲より下でも線は引く。** 描かずに落とすと、画面の途中で
                  // 線が切れて終わる（実データで先頭 400 行のうち 3 本がこれになった）。
                  // 下端まで引いて viewBox で切り、続いていることを見せる。
                  const below = target === undefined || target >= visible.length;
                  return (
                    <path
                      key={nth}
                      className="graph__line"
                      d={
                        below
                          ? edgePath(edge, index, visible.length, edge.toLane)
                          : edgePath(edge, index, target, visible[target].lane)
                      }
                      // 色は「その辺が走るレーン」に合わせる。合流でも枝の色が保たれる。
                      stroke={laneColor(edge.toLane)}
                    />
                  );
                })}
              </g>
            ))}
          </g>

          <g className="graph__nodes">
            {visible.map((row, index) => {
              const commit = bySha.get(row.sha);
              const merge = (commit?.parents.length ?? 0) > 1;
              const color = laneColor(row.lane);
              return (
                <g
                  key={row.sha}
                  className="graph__node"
                  transform={`translate(${laneX(row.lane)} ${rowY(index)})`}
                  onClick={() => onSelect(row.sha)}
                >
                  {row.sha === headSha && (
                    <circle className="graph__ring" r={RING_RADIUS} stroke={color} />
                  )}
                  {row.sha === selectedSha && (
                    <circle className="graph__selected" r={RING_RADIUS} fill={color} />
                  )}
                  <circle
                    className={merge ? "graph__dot graph__dot--merge" : "graph__dot"}
                    r={NODE_RADIUS}
                    stroke={color}
                    fill={merge ? "var(--graph-node-fill)" : color}
                  />
                  {/* 当たり判定。点が小さすぎて掴めないため行全体を受ける。 */}
                  <rect
                    className="graph__hit"
                    x={-laneX(row.lane)}
                    y={-ROW_HEIGHT / 2}
                    width={width}
                    height={ROW_HEIGHT}
                  >
                    <title>{`${commit?.shortSha ?? ""} ${commit?.subject ?? ""}`}</title>
                  </rect>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {rows.length > visible.length && (
        <p className="graph__note">{ja.graph.truncated(visible.length, rows.length)}</p>
      )}
    </div>
  );
}
