/**
 * 差分の中の検索（T-25。純関数。docs/DESIGN.md §6.5 の `Ctrl+F`）。
 *
 * **探すのは開いているファイルの差分の中だけ。** 他のファイルやコミットは
 * またがない（またぐ検索は v1.1 の「コミット検索」の話）。
 *
 * **当たった行へ移動する**方式にしてある。文字そのものを塗らないのは、
 * 行の描画に語単位差分と構文色が既に載っていて、そこへ 3 つ目の色を
 * 重ねると**どれが変更でどれが検索結果か読めなくなる**ため。
 * 行を囲んで「ここ」を示し、件数と前後移動で辿る（T-23 で作った
 * 「指摘の行へ飛ぶ」のと同じ見せ方）。
 */
import type { DiffRow } from "./diffRows";

/** 当たった行。`row` は行リスト（`buildRows`）の添字。 */
export type SearchHit = { row: number; hits: number };

/** その行の本文（左右に分かれていれば両方）。 */
function textsOf(row: DiffRow): string[] {
  if (row.kind === "single") return [row.line.text];
  if (row.kind === "pair") {
    const texts: string[] = [];
    if (row.left !== null) texts.push(row.left.text);
    if (row.right !== null) texts.push(row.right.text);
    return texts;
  }
  // hunk の見出しは本文ではないので探さない（`@@ -1,2 +1,2 @@` に当たっても意味が無い）。
  return [];
}

/** `needle` が `text` に何回出るか。**重なりは数えない。** */
function countIn(text: string, needle: string): number {
  let found = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return found;
    found += 1;
    from = at + needle.length;
  }
}

/**
 * 当たった行を上から順に返す。
 *
 * **大文字小文字は区別しない。** コードを追うときは打ち分けたい場面より、
 * 打ち分けずに見つけたい場面のほうが多い（区別する切り替えは v1 では持たない）。
 * **空の検索語は「まだ何も探していない」**として 0 件を返す（全行に当てない）。
 */
export function searchRows(rows: DiffRow[], query: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];

  const found: SearchHit[] = [];
  for (let row = 0; row < rows.length; row += 1) {
    const hits = textsOf(rows[row]).reduce(
      (total, text) => total + countIn(text.toLowerCase(), needle),
      0,
    );
    if (hits > 0) found.push({ row, hits });
  }
  return found;
}

/**
 * 次 / 前の当たりの番号。**端で折り返す。**
 *
 * 折り返さないと、最後の当たりで「次へ」を押したときに何も起きず、
 * **壊れているのか終わりなのか読めない**（件数は出ているので、戻ってきたと分かる）。
 * 1 件も無いときは `-1`（＝どこにも行かない）。
 */
export function stepHit(total: number, current: number, delta: number): number {
  if (total <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : total - 1;
  return (((current + delta) % total) + total) % total;
}

/** 当たりのうち、いま見ているものの行。無ければ `null`。 */
export function rowOf(hits: SearchHit[], current: number): number | null {
  if (current < 0 || current >= hits.length) return null;
  return hits[current].row;
}

/** 当たった行の集合（印を付けるため）。 */
export function hitRows(hits: SearchHit[]): Set<number> {
  return new Set(hits.map((hit) => hit.row));
}

/** 当たりの総数（行ではなく**当たった回数**）。 */
export function totalHits(hits: SearchHit[]): number {
  return hits.reduce((total, hit) => total + hit.hits, 0);
}
