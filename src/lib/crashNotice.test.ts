import { describe, expect, it } from "vitest";

import type { LogStatus } from "./ipc";
import { crashSummary, logHint } from "./crashNotice";

function status(extra: Partial<LogStatus> = {}): LogStatus {
  return {
    dir: "C:\\Users\\tatsu\\AppData\\Roaming\\com.tatsu.givsoner\\logs",
    writing: true,
    problem: null,
    ...extra,
  };
}

describe("logHint", () => {
  it("書けているときは場所を出し、開ける", () => {
    const hint = logHint(status());
    expect(hint.text).toContain("com.tatsu.givsoner");
    expect(hint.canOpen).toBe(true);
  });

  /**
   * **無い場所を案内しない。** 書けていないのに「ここに記録があります」と
   * 出すと、開いて空だったときに何が起きたのか分からなくなる。
   */
  it("書けていないときは理由を出し、前回までの記録があると書く", () => {
    const hint = logHint(status({ writing: false, problem: "権限がありません" }));
    expect(hint.text).toContain("権限がありません");
    expect(hint.text).toContain("前回までの記録");
    // フォルダ自体は開ける（前の起動のぶんが残っている）。
    expect(hint.canOpen).toBe(true);
  });

  // 端の値: 書けていないのに理由が無い。**空欄のまま出さない。**
  it("理由が無くても文になる", () => {
    const hint = logHint(status({ writing: false, problem: null }));
    expect(hint.text).toContain("理由は分かりません");
  });

  // 端の値: 置き場所そのものが無い。**開くボタンは押せない形にする。**
  it("置き場所が無ければ開けない", () => {
    const hint = logHint(status({ dir: "", writing: false, problem: "だめでした" }));
    expect(hint.canOpen).toBe(false);
    expect(hint.text).toContain("置き場所を決められなかった");
  });

  // 端の値: まだ問い合わせが返っていない。**「無い」と言い切らない。**
  it("まだ分からないときは確認中と出す", () => {
    const hint = logHint(null);
    expect(hint.canOpen).toBe(false);
    expect(hint.text).toContain("確認しています");
  });
});

describe("crashSummary", () => {
  it("そのままの長さなら触らない", () => {
    expect(crashSummary("index out of bounds")).toBe("index out of bounds");
  });

  it("改行を 1 行に潰す", () => {
    expect(crashSummary("前\n\n後  ろ")).toBe("前 後 ろ");
  });

  // 端の値: 200 文字ちょうどと 1 文字超え。
  it("200 文字までは切らず、201 文字から切る", () => {
    const just = "あ".repeat(200);
    expect(crashSummary(just)).toBe(just);
    expect(crashSummary("あ".repeat(201))).toBe(`${"あ".repeat(200)}…`);
  });

  // 端の値: 空。**空欄の箱を残さない。**
  it("空なら理由が分からないと書く", () => {
    expect(crashSummary("")).toBe("理由が分かりません。");
    expect(crashSummary("   \n ")).toBe("理由が分かりません。");
  });
});
