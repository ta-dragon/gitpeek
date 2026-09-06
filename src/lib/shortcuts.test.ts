import { describe, expect, it } from "vitest";

import { bindingOf, isTyping, matches, SHORTCUTS, type Action, type KeyPress } from "./shortcuts";

function press(key: string, extra: Partial<KeyPress> = {}): KeyPress {
  return { key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...extra };
}

describe("matches", () => {
  it("修飾キーごと一致したときだけ当たる", () => {
    expect(matches(press("p", { ctrlKey: true }), "openPalette")).toBe(true);
    expect(matches(press("p"), "openPalette")).toBe(false);
  });

  /**
   * **`Ctrl+R` と `Ctrl+Shift+R` は別の動作。** 修飾キーを緩く見ると、
   * 全リポジトリの fetch が現在のリポジトリの fetch にも当たる。
   */
  it("Shift の有無で別の動作になる", () => {
    const withShift = press("r", { ctrlKey: true, shiftKey: true });
    const without = press("r", { ctrlKey: true });

    expect(matches(without, "fetchCurrent")).toBe(true);
    expect(matches(without, "fetchAll")).toBe(false);
    expect(matches(withShift, "fetchAll")).toBe(true);
    expect(matches(withShift, "fetchCurrent")).toBe(false);
  });

  it("Alt の有無でコミット移動とファイル移動が分かれる", () => {
    const alt = press("ArrowDown", { altKey: true });
    const plain = press("ArrowDown");

    expect(matches(alt, "fileNext")).toBe(true);
    expect(matches(alt, "commitDown")).toBe(false);
    expect(matches(plain, "commitDown")).toBe(true);
    expect(matches(plain, "fileNext")).toBe(false);
  });

  it("別名のどちらでも当たる（↓ と j）", () => {
    expect(matches(press("ArrowDown"), "commitDown")).toBe(true);
    expect(matches(press("j"), "commitDown")).toBe(true);
    expect(matches(press("k"), "commitUp")).toBe(true);
  });

  it("英字は大文字でも当たる", () => {
    expect(matches(press("P", { ctrlKey: true }), "openPalette")).toBe(true);
    // **Shift を求めていない割り当てに Shift 付きは当たらない。**
    expect(matches(press("P", { ctrlKey: true, shiftKey: true }), "openPalette")).toBe(false);
  });

  // 端の値: Windows キー / Cmd。**どの割り当てにも使っていない。**
  it("meta が押されていればすべて外れる", () => {
    for (const binding of SHORTCUTS) {
      expect(matches(press(binding.keys[0], { metaKey: true, ctrlKey: binding.ctrl ?? false }), binding.action)).toBe(
        false,
      );
    }
  });

  it("F5 と Esc は修飾キー無しで当たる", () => {
    expect(matches(press("F5"), "reload")).toBe(true);
    expect(matches(press("F5", { ctrlKey: true }), "reload")).toBe(false);
    expect(matches(press("Escape"), "close")).toBe(true);
  });
});

describe("SHORTCUTS", () => {
  /**
   * **同じ押し方が 2 つの動作に当たらないこと。** 当たると、押した人には
   * どちらが起きたのか分からない（設定画面の一覧も嘘になる）。
   */
  it("同じ押し方が 2 つの動作に当たらない", () => {
    const seen = new Map<string, Action>();
    for (const binding of SHORTCUTS) {
      for (const key of binding.keys) {
        const shape = [
          key.toLowerCase(),
          binding.ctrl === true ? "ctrl" : "",
          binding.shift === true ? "shift" : "",
          binding.alt === true ? "alt" : "",
        ].join("+");
        const already = seen.get(shape);
        expect(already, `${shape} が ${already} と ${binding.action} で重なっている`).toBeUndefined();
        seen.set(shape, binding.action);
      }
    }
  });

  it("一覧に出す表記が全部埋まっている", () => {
    for (const binding of SHORTCUTS) {
      expect(binding.label.length, `${binding.action} の表記が空`).toBeGreaterThan(0);
      expect(bindingOf(binding.action)).toBe(binding);
    }
  });

  // DESIGN.md §6.5 の表と本数を揃える（**足したら表も直す**）。
  it("§6.5 の表を全部持っている", () => {
    const actions = SHORTCUTS.map((binding) => binding.action);
    for (const action of [
      "openPalette",
      "fetchCurrent",
      "fetchAll",
      "openReview",
      "openSettings",
      "findInDiff",
      "reload",
      "gotoHead",
      "commitDown",
      "commitUp",
      "commitFirst",
      "commitLast",
      "parentCommit",
      "childCommit",
      "fileNext",
      "filePrev",
      "focusDiff",
      "close",
    ] as Action[]) {
      expect(actions).toContain(action);
    }
  });
});

describe("isTyping", () => {
  function element(tagName: string, contentEditable = false): EventTarget {
    return { tagName, isContentEditable: contentEditable } as unknown as EventTarget;
  }

  it("入力欄では横取りしない", () => {
    expect(isTyping(element("INPUT"))).toBe(true);
    expect(isTyping(element("TEXTAREA"))).toBe(true);
    expect(isTyping(element("SELECT"))).toBe(true);
    expect(isTyping(element("DIV", true))).toBe(true);
  });

  it("それ以外では横取りする", () => {
    expect(isTyping(element("DIV"))).toBe(false);
    expect(isTyping(element("BUTTON"))).toBe(false);
    // 端の値: 対象が無い（ウィンドウ自体で受けたとき）。
    expect(isTyping(null)).toBe(false);
  });
});
