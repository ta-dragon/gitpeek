import { describe, expect, it } from "vitest";

import { clearCompare, selectCommit, swapEnds } from "./compareSelection";

const none = { selectedCommit: null, compareCommit: null };

describe("selectCommit", () => {
  it("普通のクリックは 1 点選択", () => {
    expect(selectCommit(none, "a", false)).toEqual({ selectedCommit: "a", compareCommit: null });
  });

  it("普通のクリックは比較を解除する", () => {
    const comparing = { selectedCommit: "b", compareCommit: "a" };
    expect(selectCommit(comparing, "c", false)).toEqual({
      selectedCommit: "c",
      compareCommit: null,
    });
  });

  // A を選んでから B を Ctrl+クリック → 「A から B への差分」。
  it("Ctrl+クリックは今の選択を比較元へ押し出す", () => {
    const selected = { selectedCommit: "a", compareCommit: null };
    expect(selectCommit(selected, "b", true)).toEqual({
      selectedCommit: "b",
      compareCommit: "a",
    });
  });

  // 起点を固定したまま比較先だけ付け替えられること。
  it("比較中の Ctrl+クリックは比較元を動かさない", () => {
    const comparing = { selectedCommit: "b", compareCommit: "a" };
    expect(selectCommit(comparing, "c", true)).toEqual({
      selectedCommit: "c",
      compareCommit: "a",
    });
  });

  it("何も選んでいなければ Ctrl+クリックもただの選択", () => {
    expect(selectCommit(none, "a", true)).toEqual({ selectedCommit: "a", compareCommit: null });
  });

  // 差分が空になるだけなので、比較にはしない。
  it("自分自身とは比較しない", () => {
    const selected = { selectedCommit: "a", compareCommit: null };
    expect(selectCommit(selected, "a", true)).toEqual({
      selectedCommit: "a",
      compareCommit: null,
    });
  });

  // ここを畳まないと「A と A を比較」という空の比較が残る。
  it("比較元と同じところを Ctrl+クリックすると比較が畳まれる", () => {
    const comparing = { selectedCommit: "b", compareCommit: "a" };
    expect(selectCommit(comparing, "a", true)).toEqual({
      selectedCommit: "a",
      compareCommit: null,
    });
  });
});

describe("swapEnds", () => {
  it("比較元と比較先を入れ替える", () => {
    expect(swapEnds({ selectedCommit: "b", compareCommit: "a" })).toEqual({
      selectedCommit: "a",
      compareCommit: "b",
    });
  });

  it("比較していなければ何もしない", () => {
    const selected = { selectedCommit: "a", compareCommit: null };
    expect(swapEnds(selected)).toEqual(selected);
  });
});

describe("clearCompare", () => {
  it("選択は残して比較だけやめる", () => {
    expect(clearCompare({ selectedCommit: "b", compareCommit: "a" })).toEqual({
      selectedCommit: "b",
      compareCommit: null,
    });
  });
});
