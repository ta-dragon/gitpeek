/**
 * レーン配列 → SVG パス。**ここは純関数だけを置く**（docs/DESIGN.md §14.4）。
 *
 * Rust 側（`src-tauri/src/graph/lane.rs`）が返すのはレーン番号だけで、色も座標も
 * 持たない。座標に落とすのと色を決めるのがこのファイルの仕事。
 *
 * 寸法は CLAUDE.md §6 の固定値。変えるときは DESIGN.md §5.2 も直すこと。
 */

/** 行の高さ。テーマの `--row-height` と同じ値であること。 */
export const ROW_HEIGHT = 28;
/** レーン 1 本の幅。 */
export const LANE_WIDTH = 14;
/** ノード列の左マージン。 */
export const LEFT_MARGIN = 12;
/** 分岐 / 合流の角丸の大きさ。8〜12px の範囲で調整可（DESIGN.md §5.2）。 */
export const CORNER_RADIUS = 10;

/** 通常ノードの半径。 */
export const NODE_RADIUS = 4;
/** HEAD のリングと選択中のノードの半径。 */
export const RING_RADIUS = 6;

/** レーンの色数。lane 0（幹）はこれに含めない。 */
export const LANE_COLORS = 8;

/** `src-tauri/src/graph/lane.rs` の `Edge` に対応。 */
export type Edge = {
  fromLane: number;
  toLane: number;
  parentSha: string;
  isMergeSecondParent: boolean;
};

/** `src-tauri/src/graph/lane.rs` の `GraphRow` に対応。 */
export type GraphRow = {
  sha: string;
  lane: number;
  passing: number[];
  edges: Edge[];
};

/** レーン番号 → 中心の x 座標。 */
export function laneX(lane: number): number {
  return LEFT_MARGIN + lane * LANE_WIDTH;
}

/** 行番号 → 中心の y 座標。 */
export function rowY(rowIndex: number): number {
  return rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/**
 * グラフ列の幅。`maxLane` は**実際に使われた最大のレーン番号**（0 起点）なので
 * 1 本ぶん足りない。右端のノードが半分欠けるのを防ぐため右マージンも足す。
 */
export function graphWidth(maxLane: number): number {
  return LEFT_MARGIN + (maxLane + 1) * LANE_WIDTH;
}

/**
 * 行 `rowIndex` から親の行 `targetRowIndex` へ伸びる辺のパス。
 *
 * **`edge.toLane` は「途中を走るレーン」であって親のレーンではない。** 枝の第一親は
 * 同じレーンを予約したまま親の行まで下り、そこで親が lane 0 を取るとレーンが解放される
 * （`lane.rs` の手順 2）。そのため親のレーン `targetLane` を別に受け取り、
 * 必要なら**下側でもう一度曲げて**ノードに接続する。ここを `toLane` で描くと、
 * 合流のたびに線とノードの間に隙間が空く。
 *
 * 形は「垂直 → 角丸ベジェ → 垂直」。直角エルボーや斜め直線にはしない（DESIGN.md §5.2）。
 */
export function edgePath(
  edge: Edge,
  rowIndex: number,
  targetRowIndex: number,
  targetLane: number,
): string {
  const x0 = laneX(edge.fromLane);
  const y0 = rowY(rowIndex);
  const x1 = laneX(targetLane);
  const y1 = rowY(targetRowIndex);

  // 親が同じ行か上にある（topo-order では起こり得ないが、描けないより直線を引く）。
  const span = y1 - y0;
  if (span <= 0) {
    return `M ${n(x0)} ${n(y0)} L ${n(x1)} ${n(y1)}`;
  }

  let xMid = laneX(edge.toLane);
  let top = bendHeight(xMid - x0);
  let bottom = bendHeight(x1 - xMid);

  // **中間レーンを走る余地が無いなら、そのレーンは経由しない。** 第 2 親のために
  // 起こしたレーンが 1〜2 行で終わると、右へ跳ねてすぐ左へ戻る弧になって飛び出して見える。
  // どのみち縦に走る区間が無いレーンなので、通らずに直接繋ぐ方が実態に近い。
  if (top > 0 && bottom > 0 && top + bottom > span) {
    xMid = x1;
    top = bendHeight(xMid - x0);
    bottom = 0;
  }

  // 同一レーンを下るだけ。幹はこれだけで描ける。
  if (top === 0 && bottom === 0) {
    return `M ${n(x0)} ${n(y0)} L ${n(x0)} ${n(y1)}`;
  }

  // それでも収まらなければ曲がりを縮める。曲がり切る前に次の曲がりが始まらないように。
  if (top + bottom > span) {
    const scale = span / (top + bottom);
    top *= scale;
    bottom *= scale;
  }

  const yAfterTop = y0 + top;
  const yBeforeBottom = y1 - bottom;

  const parts = [`M ${n(x0)} ${n(y0)}`];
  // 上の曲がり。ノードを出てすぐ目的のレーンへ移る。
  if (top > 0) {
    parts.push(
      `C ${n(x0)} ${n(y0 + top / 2)} ${n(xMid)} ${n(yAfterTop - top / 2)} ${n(xMid)} ${n(yAfterTop)}`,
    );
  }
  if (yBeforeBottom > yAfterTop) {
    parts.push(`L ${n(xMid)} ${n(yBeforeBottom)}`);
  }
  // 下の曲がり。親のノードの手前で寄せる。
  if (bottom > 0) {
    parts.push(
      `C ${n(xMid)} ${n(yBeforeBottom + bottom / 2)} ${n(x1)} ${n(y1 - bottom / 2)} ${n(x1)} ${n(y1)}`,
    );
  }

  return parts.join(" ");
}

/**
 * 横に `dx` だけ移動する曲がりに要する縦の長さ。
 *
 * **横の距離に応じて伸ばす。** 何レーンまたいでも角丸を固定長にすると、
 * 数レーンぶんの移動が 20px の帯に押し込まれて、ほぼ水平の直線に見える
 * （実データで 1 行のあいだに 8 レーン移動する辺があった）。
 * 1 レーンぶんの移動では `CORNER_RADIUS * 2` を下限にして、従来の見た目を保つ。
 */
function bendHeight(dx: number): number {
  const distance = Math.abs(dx);
  return distance === 0 ? 0 : Math.max(CORNER_RADIUS * 2, distance);
}

/**
 * レーンの色。**CSS 変数名を返す**（SVG 属性に生の色値を書かない — CLAUDE.md §6）。
 *
 * lane 0 は必ず幹なので無彩色寄りの固定色にできる（`lane.rs` の予約による）。
 * ブランチ名のハッシュで色を決める方式は採らない（DESIGN.md §5.2）。
 */
export function laneColor(lane: number): string {
  if (lane === 0) return "var(--graph-lane-trunk)";
  return `var(--graph-lane-${(lane - 1) % LANE_COLORS})`;
}

/** SHA → 行番号。辺の行き先を引くのに使う。行ごとに探すと数万行で効く。 */
export function rowIndexBySha(rows: GraphRow[]): Map<string, number> {
  const index = new Map<string, number>();
  rows.forEach((row, i) => index.set(row.sha, i));
  return index;
}

/** 座標の整形。整数はそのまま、端数だけ小数 1 桁に丸める。 */
function n(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
