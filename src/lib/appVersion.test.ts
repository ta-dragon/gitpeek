import { describe, expect, it } from "vitest";

import { ja } from "../i18n/ja";
import { versionLine, windowTitle } from "./appVersion";

// 文言そのものは assert しない（CLAUDE.md §8）。見るのは「版が入るか」「開発用が見分けられるか」。

const release = { version: "0.2.5", dev: false };
const dev = { version: "0.2.5", dev: true };

describe("windowTitle", () => {
  it("版の数字を名前と一緒に出す", () => {
    const title = windowTitle(release);
    expect(title).toContain(ja.app.name);
    expect(title).toContain("0.2.5");
  });

  it("開発用の起動は、同じ版のリリースと見分けが付く", () => {
    expect(windowTitle(dev)).toContain("0.2.5");
    expect(windowTitle(dev)).not.toBe(windowTitle(release));
  });

  it("読めなかったら、いままでどおり名前だけにする", () => {
    expect(windowTitle(null)).toBe(ja.app.name);
  });
});

describe("versionLine", () => {
  it("タイトルと同じ形で出す", () => {
    expect(versionLine(release)).toBe(windowTitle(release));
    expect(versionLine(dev)).toBe(windowTitle(dev));
  });

  it("読めなかったときは黙って消さず、名前だけとも違う形で出す", () => {
    const line = versionLine(null);
    expect(line).not.toBe("");
    expect(line).not.toBe(ja.app.name);
  });
});
