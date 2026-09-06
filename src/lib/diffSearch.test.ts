import { describe, expect, it } from "vitest";

import { buildRows } from "./diffRows";
import { hitRows, rowOf, searchRows, stepHit, totalHits } from "./diffSearch";
import type { DiffLine, DiffLineKind, Hunk } from "./ipc";

function line(kind: DiffLineKind, text: string): DiffLine {
  return { kind, text, oldLine: null, newLine: null, ending: "lf" };
}

function hunk(lines: DiffLine[]): Hunk {
  return { oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, heading: "fn main()", lines };
}

const HUNKS: Hunk[] = [
  hunk([
    line("context", "let value = 1;"),
    line("removed", "let Value = 2;"),
    line("added", "let value = 3; // value"),
  ]),
];

describe("searchRows", () => {
  it("当たった行を上から順に返す", () => {
    const rows = buildRows(HUNKS, "unified");
    const hits = searchRows(rows, "value");
    // ["@", context, removed, added] の 1・2・3 行目が当たる。
    expect(hits.map((hit) => hit.row)).toEqual([1, 2, 3]);
  });

  it("大文字小文字を区別しない", () => {
    const rows = buildRows(HUNKS, "unified");
    expect(searchRows(rows, "VALUE").map((hit) => hit.row)).toEqual([1, 2, 3]);
  });

  it("1 行に複数あれば数える", () => {
    const rows = buildRows(HUNKS, "unified");
    const hits = searchRows(rows, "value");
    expect(hits[2].hits).toBe(2);
    expect(totalHits(hits)).toBe(4);
  });

  /** **hunk の見出しは探さない。** `@@` に当たっても意味が無い。 */
  it("hunk の見出しには当たらない", () => {
    const rows = buildRows(HUNKS, "unified");
    expect(searchRows(rows, "fn main").length).toBe(0);
    expect(rows[0].kind).toBe("hunk");
  });

  it("左右に並べたときは両側を見る", () => {
    const rows = buildRows(HUNKS, "side-by-side");
    const hits = searchRows(rows, "value");
    // 左（removed）と右（added）が同じ行に来るので、その行の当たりは 3 回。
    expect(hits.some((hit) => hit.hits === 3)).toBe(true);
  });

  // 端の値: 空 / 空白だけ。**全行に当てない。**
  it("空の検索語は 0 件", () => {
    const rows = buildRows(HUNKS, "unified");
    expect(searchRows(rows, "")).toEqual([]);
    expect(searchRows(rows, "   ")).toEqual([]);
  });

  // 端の値: 当たらない / 行が無い。
  it("当たらないときと行が無いときは 0 件", () => {
    expect(searchRows(buildRows(HUNKS, "unified"), "見つからない")).toEqual([]);
    expect(searchRows([], "value")).toEqual([]);
  });
});

describe("stepHit", () => {
  it("次と前へ動く", () => {
    expect(stepHit(3, 0, 1)).toBe(1);
    expect(stepHit(3, 1, -1)).toBe(0);
  });

  // **端では折り返す。** 折り返さないと、終わりなのか壊れたのか読めない。
  it("端で折り返す", () => {
    expect(stepHit(3, 2, 1)).toBe(0);
    expect(stepHit(3, 0, -1)).toBe(2);
  });

  // 端の値: まだどれも見ていない（-1）。
  it("まだ見ていなければ先頭（前へなら末尾）", () => {
    expect(stepHit(3, -1, 1)).toBe(0);
    expect(stepHit(3, -1, -1)).toBe(2);
  });

  // 端の値: 1 件だけ / 0 件。
  it("1 件なら動かず、0 件ならどこにも行かない", () => {
    expect(stepHit(1, 0, 1)).toBe(0);
    expect(stepHit(1, 0, -1)).toBe(0);
    expect(stepHit(0, -1, 1)).toBe(-1);
    expect(stepHit(0, 0, -1)).toBe(-1);
  });
});

describe("rowOf / hitRows", () => {
  const hits = [
    { row: 2, hits: 1 },
    { row: 5, hits: 3 },
  ];

  it("いま見ている当たりの行を返す", () => {
    expect(rowOf(hits, 0)).toBe(2);
    expect(rowOf(hits, 1)).toBe(5);
  });

  // 端の値: 範囲の外。**落とさず `null`。**
  it("範囲の外では null", () => {
    expect(rowOf(hits, -1)).toBeNull();
    expect(rowOf(hits, 2)).toBeNull();
    expect(rowOf([], 0)).toBeNull();
  });

  it("印を付ける行の集合を作る", () => {
    expect([...hitRows(hits)]).toEqual([2, 5]);
    expect(hitRows([]).size).toBe(0);
  });
});
