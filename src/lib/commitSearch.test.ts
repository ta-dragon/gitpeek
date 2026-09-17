import { describe, expect, it } from "vitest";

import {
  estimateSeconds,
  hitAfter,
  hitRows,
  hitsIn,
  learnedRate,
  rowOf,
  searchProgress,
  searchView,
  stepHit,
} from "./commitSearch";

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
    running: false,
    searched: false,
    hits: { rows: [], hidden: 0 },
    current: -1,
    notices: [],
    cancelled: false,
    error: null,
    timing: null,
  };

  it("まだ何もしていなければ何も出さない", () => {
    expect(searchView(idle)).toEqual({
      canStep: false,
      position: null,
      canClear: false,
      canCancel: false,
      progress: null,
      notes: [],
    });
  });

  it("当たったら件数と今の位置を出し、前後に辿れる", () => {
    const view = searchView({
      ...idle,
      input: "x",
      searched: true,
      hits: { rows: [1, 3], hidden: 0 },
      current: 1,
    });
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

  it("中止したら「当たらなかった」と言わず、全部ではないと言う", () => {
    // 最後まで見ていないので、0 件でも「当たりませんでした」は嘘になる。
    const view = searchView({ ...idle, input: "code:x", searched: true, cancelled: true });
    expect(view.notes).toEqual([{ kind: "cancelled" }]);
  });

  it("中止しても、そこまでに当たったぶんは辿れる", () => {
    const view = searchView({
      ...idle,
      input: "code:x",
      searched: true,
      cancelled: true,
      hits: { rows: [2], hidden: 0 },
      current: 0,
    });
    expect(view.canStep).toBe(true);
    expect(view.notes).toEqual([{ kind: "cancelled" }]);
  });

  it("効かなかった打ち方と失敗を並べて出す", () => {
    const view = searchView({
      ...idle,
      input: "message:",
      notices: [{ kind: "emptyValue", key: "message" }],
      error: "boom",
    });
    expect(view.notes.map((note) => note.kind)).toEqual(["emptyValue", "failed"]);
    // 知らせが出ているあいだは、消す手段も出す。
    expect(view.canClear).toBe(true);
  });

  it("辿っている 1 件が決まっていなければ位置は出さない", () => {
    const view = searchView({
      ...idle,
      searched: true,
      hits: { rows: [1], hidden: 0 },
      current: -1,
    });
    expect(view.position).toBeNull();
    expect(view.canStep).toBe(true);
  });

  it("コード内容を探している間だけ、目安と中止ボタンを出す", () => {
    const view = searchView({
      ...idle,
      input: "code:x",
      running: true,
      timing: { estimateSeconds: 17, elapsedMs: 5_400 },
    });
    expect(view.canCancel).toBe(true);
    expect(view.progress).toEqual({ kind: "estimate", seconds: 17, elapsed: 5 });
  });

  it("メッセージだけの検索では中止ボタンを出さない", () => {
    // 一瞬で終わるので、出すとボタンが光って消えるだけになる。
    const view = searchView({ ...idle, input: "x", running: true });
    expect(view.canCancel).toBe(false);
    expect(view.progress).toBeNull();
  });

  it("走り終わったら目安も中止ボタンも消す", () => {
    const view = searchView({
      ...idle,
      input: "code:x",
      searched: true,
      timing: { estimateSeconds: 17, elapsedMs: 17_000 },
    });
    expect(view.canCancel).toBe(false);
    expect(view.progress).toBeNull();
  });
});

describe("estimateSeconds", () => {
  it("初回は既定のレートで見積もる", () => {
    // onyx: 20,285 コミット ÷ 1,200 ≒ 17 秒（実測 17.1 秒）。
    expect(estimateSeconds(20_285, null)).toBe(17);
  });

  it("実測があればそれを使う", () => {
    expect(estimateSeconds(10_186, 2_750)).toBe(4);
  });

  it("1 秒未満でも 1 秒と言う", () => {
    // 「0 秒」は壊れて見える。
    expect(estimateSeconds(10, null)).toBe(1);
    expect(estimateSeconds(0, null)).toBe(1);
  });

  it("壊れたレートは使わない", () => {
    expect(estimateSeconds(12_000, 0)).toBe(estimateSeconds(12_000, null));
    expect(estimateSeconds(12_000, -5)).toBe(estimateSeconds(12_000, null));
  });
});

describe("learnedRate", () => {
  const codeOnly = { any: null, message: null, author: null, code: "NEEDLE" };

  it("code: だけで最後まで走った実行から、1 秒あたりのコミット数を覚える", () => {
    expect(learnedRate(codeOnly, { elapsedMs: 17_100, cancelled: false }, 20_285)).toBeCloseTo(
      1_186.3,
      1,
    );
  });

  it("次の見積もりに効く", () => {
    const rate = learnedRate(codeOnly, { elapsedMs: 3_700, cancelled: false }, 10_186);
    expect(estimateSeconds(10_186, rate)).toBe(4);
  });

  it("ほかの指定と一緒の実行は覚えない", () => {
    // 絞った実行は速い（17.1 秒 → 5.9 秒）。覚えると code: だけのときに短く言いすぎる。
    const narrowed = { ...codeOnly, message: "fix" };
    expect(learnedRate(narrowed, { elapsedMs: 5_900, cancelled: false }, 20_285)).toBeNull();
    const bare = { ...codeOnly, any: "fix" };
    expect(learnedRate(bare, { elapsedMs: 5_900, cancelled: false }, 20_285)).toBeNull();
  });

  it("中止した実行は覚えない", () => {
    expect(learnedRate(codeOnly, { elapsedMs: 5_000, cancelled: true }, 20_285)).toBeNull();
  });

  it("短すぎる実行は覚えない", () => {
    // 起動にかかる時間が大半で、レートが実際より大きく出る。
    expect(learnedRate(codeOnly, { elapsedMs: 300, cancelled: false }, 500)).toBeNull();
  });

  it("コード内容を探していない実行は覚えない", () => {
    const message = { ...codeOnly, code: null, message: "fix" };
    expect(learnedRate(message, { elapsedMs: 5_000, cancelled: false }, 20_285)).toBeNull();
  });
});

describe("searchProgress", () => {
  it("目安の内は、目安と経過を言う", () => {
    expect(searchProgress(17, 0)).toEqual({ kind: "estimate", seconds: 17, elapsed: 0 });
    expect(searchProgress(17, 17_000)).toEqual({ kind: "estimate", seconds: 17, elapsed: 17 });
  });

  it("目安を超えたら、残り時間を言わず経過だけを言う", () => {
    // 「あと 0 秒」のまま待たせ続けない。
    expect(searchProgress(17, 17_001)).toEqual({ kind: "overdue", elapsed: 17 });
    expect(searchProgress(17, 30_500)).toEqual({ kind: "overdue", elapsed: 30 });
  });
});
