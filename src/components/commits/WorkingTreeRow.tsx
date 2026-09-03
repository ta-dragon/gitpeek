/**
 * コミットリスト最上部の作業ツリー擬似行（docs/DESIGN.md §7.5）。
 *
 * **レーン計算の対象外**（CLAUDE.md §3-6）。グラフ側は擬似行のぶんだけ下へずらして
 * 描き、この行は自分でノードと点線を描く。レーンに混ぜると、作業ツリーが
 * 汚れているかどうかでグラフ全体の形が変わってしまう。
 *
 * **作業ツリーがクリーンなときは呼び出し側が出さない。**
 */
import { ja } from "../../i18n/ja";
import { laneColor, laneX, NODE_RADIUS, ROW_HEIGHT } from "../../lib/graphPath";
import type { ColumnWidths } from "../../lib/ipc";
import type { WorkingSummary } from "../../lib/workingTree";

export function WorkingTreeRow({
  summary,
  selected,
  columns,
  graphWidth,
  headLane,
  connected,
  onSelect,
}: {
  summary: WorkingSummary;
  selected: boolean;
  columns: ColumnWidths;
  graphWidth: number;
  /** HEAD が乗っているレーン。分からなければ 0（幹）に寄せる。 */
  headLane: number;
  /**
   * すぐ下の行が HEAD か。**点線を引くのはこのときだけ** —
   * 途中に別のコミットが挟まると、線がどこへ向かっているのか分からなくなる。
   */
  connected: boolean;
  onSelect: () => void;
}) {
  const x = laneX(headLane);
  const color = laneColor(headLane);

  return (
    <div
      className={`crow crow--worktree${selected ? " crow--selected" : ""}`}
      onClick={onSelect}
      role="row"
    >
      <div className="crow__graph" style={{ width: graphWidth }}>
        <svg width={graphWidth} height={ROW_HEIGHT} role="presentation" aria-hidden="true">
          {connected && (
            <line
              className="graph__dotted"
              x1={x}
              y1={ROW_HEIGHT / 2}
              x2={x}
              y2={ROW_HEIGHT}
              stroke={color}
            />
          )}
          {/* 中を塗らない丸。**まだコミットではない**ことを形で示す。 */}
          <circle
            className="graph__dot"
            cx={x}
            cy={ROW_HEIGHT / 2}
            r={NODE_RADIUS}
            stroke={color}
            fill="var(--graph-node-fill)"
          />
        </svg>
      </div>

      <div className="crow__subject" style={{ width: columns.subject }}>
        <span className="crow__worktreeTag">{ja.workingTree.row}</span>
        <span className="crow__text">{describe(summary)}</span>
      </div>

      <div className="crow__author" style={{ width: columns.author }} />
      <div className="crow__date" style={{ width: columns.date }} />
      <div className="crow__sha" style={{ width: columns.sha }} />
    </div>
  );
}

/** 「衝突 1 / ステージ済み 2 / 未ステージ 1 / 未追跡 3」のように並べる。 */
function describe(summary: WorkingSummary): string {
  const parts: string[] = [];
  if (summary.unmerged > 0) parts.push(ja.workingTree.count.unmerged(summary.unmerged));
  if (summary.staged > 0) parts.push(ja.workingTree.count.staged(summary.staged));
  if (summary.unstaged > 0) parts.push(ja.workingTree.count.unstaged(summary.unstaged));
  if (summary.untracked > 0) parts.push(ja.workingTree.count.untracked(summary.untracked));
  return parts.join(" / ");
}
