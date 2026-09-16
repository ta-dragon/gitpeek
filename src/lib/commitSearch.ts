/**
 * 探した結果を行に落とす（T-35。純関数。docs/DESIGN.md §6.6）。
 *
 * **グラフと行は変えない。** 当たった行に印を付け、件数と前後移動で辿る
 * （差分内検索と同じ見せ方）。行を絞らないのは、レーンが**可視 ref の到達可能集合**
 * から計算されているためで、任意の部分集合に絞ると線が意味を失う（CLAUDE.md §3）。
 *
 * **表示していない ref の側に当たったぶんは、件数として残す。** 黙って落とすと、
 * 「探したのに出ない」のか「そもそも当たっていない」のか読めなくなる。
 */
import type { QueryNotice } from "./commitQuery";
import { stepHit } from "./diffSearch";

/** 端で折り返す前後移動。**差分内検索と同じ決まりを 2 つ持たない**ので再利用する。 */
export { stepHit };

export type SearchHits = {
  /** 当たった行の番号（表示している並びでの昇順）。 */
  rows: number[];
  /** 当たったが、いま表示していない件数（可視 ref の絞り込みで行が無いもの）。 */
  hidden: number;
};

/** 1 件も当たっていない状態。 */
export const NO_HITS: SearchHits = { rows: [], hidden: 0 };

/**
 * 当たった SHA を行番号に直す。
 *
 * `shown` は**表示している並びそのもの**（`LaneLayout.rows` から作ったもの）を渡すこと。
 * 読み込んだ全コミットを渡すと、絞り込みや date 表示で**印が 1 行ずつずれる**。
 */
export function hitsIn(shown: readonly string[], shas: readonly string[]): SearchHits {
  const wanted = new Set(shas);
  const rows: number[] = [];
  for (let row = 0; row < shown.length; row += 1) {
    if (wanted.has(shown[row])) rows.push(row);
  }
  return { rows, hidden: Math.max(0, wanted.size - rows.length) };
}

/** いま見ている当たりの行。無ければ `null`。 */
export function rowOf(hits: SearchHits, current: number): number | null {
  if (current < 0 || current >= hits.rows.length) return null;
  return hits.rows[current];
}

/**
 * 探した直後にどの当たりへ行くか。**いま選んでいる行から下へ探し、無ければ先頭へ戻る。**
 *
 * いつも先頭へ飛ぶと、下のほうを見ているときに毎回画面が一番上へ戻る。
 * 1 件も当たっていなければ `-1`（＝どこにも行かない）。
 */
export function hitAfter(hits: SearchHits, fromRow: number | null): number {
  if (hits.rows.length === 0) return -1;
  if (fromRow === null) return 0;
  const found = hits.rows.findIndex((row) => row >= fromRow);
  return found < 0 ? 0 : found;
}

/** 当たった行の集合（印を付けるため）。 */
export function hitRows(hits: SearchHits): Set<number> {
  return new Set(hits.rows);
}

/**
 * ツールバーに出す知らせ。**文言は持たない**（`i18n/ja.ts` が種類から引く）。
 *
 * 効かなかった打ち方（`QueryNotice`）もここへ混ぜて、1 列に並べて出す。
 */
export type SearchNote =
  | { kind: "none" }
  | { kind: "hidden"; count: number }
  | { kind: "codeUnsupported" }
  | { kind: "failed"; detail: string }
  | QueryNotice;

/** 画面の出し分けに要る材料。`hooks/useCommitSearch.ts` が持っている値そのもの。 */
export type SearchState = {
  input: string;
  searched: boolean;
  hits: SearchHits;
  current: number;
  notices: QueryNotice[];
  codeUnsupported: boolean;
  error: string | null;
};

export type SearchView = {
  /** 「次へ / 前へ」を押せるか。**押せなくても消さない**（CLAUDE.md §6）。 */
  canStep: boolean;
  /** 何件目を見ているか。当たりが無ければ `null`（件数を出さない）。 */
  position: { current: number; total: number } | null;
  /** 「やめる」を出すか。何も打っておらず何も探していなければ出さない。 */
  canClear: boolean;
  notes: SearchNote[];
};

/**
 * ツールバーの出し分け。**`.tsx` に判定を書かないために、ここで決める**（CLAUDE.md §8）。
 *
 * - **表示していない側にだけ当たったときは「当たりませんでした」と言わない。**
 *   当たってはいるので、そう言うと嘘になる。代わりに件数と出し方を言う
 * - 何件目かは、辿っている 1 件が決まっているときだけ出す
 */
export function searchView(state: SearchState): SearchView {
  const total = state.hits.rows.length;
  const notes: SearchNote[] = [];

  if (state.searched && total === 0 && state.hits.hidden === 0) notes.push({ kind: "none" });
  if (state.hits.hidden > 0) notes.push({ kind: "hidden", count: state.hits.hidden });
  if (state.codeUnsupported) notes.push({ kind: "codeUnsupported" });
  notes.push(...state.notices);
  if (state.error !== null) notes.push({ kind: "failed", detail: state.error });

  return {
    canStep: total > 0,
    position:
      total > 0 && state.current >= 0 && state.current < total
        ? { current: state.current + 1, total }
        : null,
    canClear: state.searched || state.input !== "" || notes.length > 0,
    notes,
  };
}
