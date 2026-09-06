import { describe, expect, it } from "vitest";

import { NUMBER_FIELDS, readChoice, readNumber, showNumber } from "./settingsForm";

describe("readNumber", () => {
  it("範囲の中なら値を返す", () => {
    expect(readNumber("contextLines", "3")).toEqual({ value: 3, reason: null });
    expect(readNumber("reviewConcurrency", "2")).toEqual({ value: 2, reason: null });
  });

  // 端の値: 最小・最大ちょうどは通る。
  it("最小と最大ちょうどは通る", () => {
    for (const [name, field] of Object.entries(NUMBER_FIELDS)) {
      const key = name as keyof typeof NUMBER_FIELDS;
      expect(readNumber(key, String(field.min)).value, `${name} の最小`).toBe(field.min);
      expect(readNumber(key, String(field.max)).value, `${name} の最大`).toBe(field.max);
    }
  });

  // 端の値: 最小 -1 と最大 +1 は理由付きで弾く。
  it("範囲の外は理由を返す", () => {
    for (const [name, field] of Object.entries(NUMBER_FIELDS)) {
      const key = name as keyof typeof NUMBER_FIELDS;
      if (field.min > 0) {
        const under = readNumber(key, String(field.min - 1));
        expect(under.value, `${name} の最小 -1`).toBeNull();
        expect(under.reason).toContain("までの数字");
      }
      const over = readNumber(key, String(field.max + 1));
      expect(over.value, `${name} の最大 +1`).toBeNull();
      expect(over.reason).toContain("までの数字");
    }
  });

  /**
   * **0 は「警告しない」という意味を持つ**ので、`staleWarningDays` では通す。
   * 並列度では最小が 1 なので弾く。
   */
  it("0 の意味は欄によって違う", () => {
    expect(readNumber("staleWarningDays", "0")).toEqual({ value: 0, reason: null });
    expect(readNumber("reviewConcurrency", "0").value).toBeNull();
  });

  // 端の値: 空欄。**0 として扱わない**（消したのか未入力なのか区別が付かなくなる）。
  it("空欄は理由を返す", () => {
    expect(readNumber("contextLines", "").reason).toContain("空欄");
    expect(readNumber("contextLines", "   ").reason).toContain("空欄");
  });

  it("数字でないものを弾く", () => {
    for (const input of ["３", "abc", "1.5", "-1", "+1", "1e3", "0x10", "1 2"]) {
      expect(readNumber("contextLines", input).value, `${input} が通っている`).toBeNull();
    }
  });

  it("前後の空白は落とす", () => {
    expect(readNumber("contextLines", "  10  ")).toEqual({ value: 10, reason: null });
  });

  // 端の値: 桁が多すぎる入力。**落ちずに理由を返す。**
  it("けた違いに大きい数でも落ちない", () => {
    const huge = readNumber("collapseBytes", "9".repeat(30));
    expect(huge.value).toBeNull();
    expect(huge.reason).not.toBe("");
  });
});

describe("showNumber", () => {
  /**
   * **範囲外の値でも書き換えない。** 手で書いた値を画面が黙って直すと、
   * 直したことに気付けない（締めるのは Rust の読み込み側）。
   */
  it("そのまま文字にする", () => {
    expect(showNumber(3)).toBe("3");
    expect(showNumber(999_999_999)).toBe("999999999");
  });
});

describe("readChoice", () => {
  it("候補にあればそのまま", () => {
    expect(readChoice("dark", ["system", "light", "dark"])).toBe("dark");
  });

  // 端の値: 候補に無い / 空。**先頭（＝既定）へ戻す**（Rust の clamp_choice と同じ）。
  it("候補に無ければ既定へ戻す", () => {
    expect(readChoice("solarized", ["system", "light", "dark"])).toBe("system");
    expect(readChoice("", ["topo", "date"])).toBe("topo");
  });
});
