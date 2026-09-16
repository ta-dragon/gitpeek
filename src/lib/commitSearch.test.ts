import { describe, expect, it } from "vitest";

import { hitAfter, hitRows, hitsIn, rowOf, searchView, stepHit } from "./commitSearch";

/** 表示している並び（`LaneLayout.rows` から作ったもの）。 */
const shown = ["aaa", "bbb", "ccc", "ddd", "eee"];

describe("hitsIn", () => {
  it("当たった SHA を、表示している並びの行番号に直す", () => {
    expect(hitsIn(shown, ["ccc", "aaa"])).toEqual({ rows: [0, 2], hidden: 0 });
  });

  it("表示していない ref の側に当たったぶんは件数として残す", () => {
    // 黙って落とすと「探したのに出ない」のか「当たっていない」のか読めない。
    expect(hitsIn(shown, ["bbb", "zzz", "yyy"])).toEqual({ rows: [1], hidden: 2 });
  });

  it("1 件も当たらなければ空", () => {
    expect(hitsIn(shown, [])).toEqual({ rows: [], hidden: 0 });
  });

  it("同じ SHA が 2 回来ても 1 件として数える", () => {
    expect(hitsIn(shown, ["bbb", "bbb"])).toEqual({ rows: [1], hidden: 0 });
  });

  it("行が 1 つも無いとき（読み込み前）でも壊れない", () => {
    expect(hitsIn([], ["aaa"])).toEqual({ rows: [], hidden: 1 });
  });
});

describe("hitAfter", () => {
  const hits = hitsIn(shown, ["bbb", "ddd"]);

  it("いま選んでいる行から下へ探す", () => {
    expect(hitAfter(hits, 0)).toBe(0);
    expect(hitAfter(hits, 2)).toBe(1);
  });

  it("その行と同じ行に当たっていれば、そこを選ぶ", () => {
    expect(hitAfter(hits, 3)).toBe(1);
  });

  it("下に無ければ先頭へ戻る", () => {
    // ここで -1 を返すと「当たっているのにどこにも行かない」ことになる。
    expect(hitAfter(hits, 4)).toBe(0);
  });

  it("どこも選んでいなければ先頭", () => {
    expect(hitAfter(hits, null)).toBe(0);
  });

  it("1 件も当たっていなければどこにも行かない", () => {
    expect(hitAfter({ rows: [], hidden: 3 }, 2)).toBe(-1);
  });
});

describe("rowOf", () => {
  const hits = hitsIn(shown, ["bbb", "ddd"]);

  it("いま見ている当たりの行を返す", () => {
    expect(rowOf(hits, 0)).toBe(1);
    expect(rowOf(hits, 1)).toBe(3);
  });

  it("範囲の外なら null", () => {
    expect(rowOf(hits, -1)).toBeNull();
    expect(rowOf(hits, 2)).toBeNull();
  });
});

describe("stepHit", () => {
  it("端で折り返す（差分内検索と同じ決まりを使う）", () => {
    expect(stepHit(2, 1, 1)).toBe(0);
    expect(stepHit(2, 0, -1)).toBe(1);
  });
});

describe("hitRows", () => {
  it("印を付ける行の集合を作る", () => {
    expect(hitRows(hitsIn(shown, ["aaa", "eee"]))).toEqual(new Set([0, 4]));
  });
});

describe("searchView", () => {
  const idle = {
    input: "",
    searched: false,
    hits: { rows: [], hidden: 0 },
    current: -1,
    notices: [],
    codeUnsupported: false,
    error: null,
  };

  it("まだ何もしていなければ何も出さない", () => {
    expect(searchView(idle)).toEqual({
      canStep: false,
      position: null,
      canClear: false,
      notes: [],
    });
  });

  it("当たったら件数と今の位置を出し、前後に辿れる", () => {
    const view = searchView({ ...idle, input: "x", searched: true, hits: { rows: [1, 3], hidden: 0 }, current: 1 });
    expect(view.canStep).toBe(true);
    expect(view.position).toEqual({ current: 2, total: 2 });
    expect(view.notes).toEqual([]);
  });

  it("1 件も当たらなければ、そう言う", () => {
    const view = searchView({ ...idle, input: "x", searched: true });
    expect(view.notes).toEqual([{ kind: "none" }]);
    expect(view.canStep).toBe(false);
  });

  it("表示していない側にだけ当たったときは「当たらなかった」と言わない", () => {
    // 当たってはいるので、そう言うと嘘になる。
    const view = searchView({ ...idle, input: "x", searched: true, hits: { rows: [], hidden: 3 } });
    expect(view.notes).toEqual([{ kind: "hidden", count: 3 }]);
  });

  it("code: を断ったこと、効かなかった打ち方、失敗を並べて出す", () => {
    const view = searchView({
      ...idle,
      input: "code:x message:",
      codeUnsupported: true,
      notices: [{ kind: "emptyValue", key: "message" }],
      error: "boom",
    });
    expect(view.notes.map((note) => note.kind)).toEqual([
      "codeUnsupported",
      "emptyValue",
      "failed",
    ]);
    // 知らせが出ているあいだは、消す手段も出す。
    expect(view.canClear).toBe(true);
  });

  it("辿っている 1 件が決まっていなければ位置は出さない", () => {
    const view = searchView({ ...idle, searched: true, hits: { rows: [1], hidden: 0 }, current: -1 });
    expect(view.position).toBeNull();
    expect(view.canStep).toBe(true);
  });
});
