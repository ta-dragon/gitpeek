import { describe, expect, it } from "vitest";

import type { StashEntry } from "./ipc";
import {
  parseStashFileKey,
  stashBaseJump,
  stashFileKey,
  stashReview,
  stashSource,
  stashTitle,
  stillStashed,
} from "./stash";

function entry(overrides: Partial<StashEntry> = {}): StashEntry {
  return {
    sha: "w",
    base: "base",
    untracked: null,
    label: "stash@{0}",
    time: 1,
    message: "On main: 作業",
    ...overrides,
  };
}

describe("stashTitle", () => {
  it("名前を付けた stash を、ブランチと本文に分ける", () => {
    expect(stashTitle("On main: 作業: 日本語のメッセージ")).toEqual({
      branch: "main",
      unnamed: false,
      // 本文の中のコロンは残す（最初の `: ` で切る）。
      text: "作業: 日本語のメッセージ",
    });
  });

  it("名前を付けずに退避したものは unnamed", () => {
    expect(stashTitle("WIP on feature/x: b57df2e 枝")).toEqual({
      branch: "feature/x",
      unnamed: true,
      text: "b57df2e 枝",
    });
  });

  it("detached で退避したものも分ける", () => {
    expect(stashTitle("WIP on (no branch): 1234567 s").branch).toBe("(no branch)");
  });

  it("分けられない形はそのまま出す", () => {
    expect(stashTitle("手で書いたメッセージ")).toEqual({
      branch: null,
      unnamed: false,
      text: "手で書いたメッセージ",
    });
  });
});

describe("stashSource", () => {
  it("追跡ぶんは元のコミット → stash", () => {
    expect(stashSource(entry(), "tracked")).toEqual({
      kind: "range",
      parent: "base",
      sha: "w",
      symmetric: false,
    });
  });

  it("未追跡ぶんはルート → 第 3 親", () => {
    expect(stashSource(entry({ untracked: "u" }), "untracked")).toEqual({
      kind: "range",
      parent: null,
      sha: "u",
      symmetric: false,
    });
  });

  it("未追跡が無ければ null", () => {
    expect(stashSource(entry(), "untracked")).toBeNull();
  });
});

describe("stashBaseJump", () => {
  const inGraph = (sha: string) => sha === "base" || sha === "filtered";

  it("グラフに出ていれば移れる", () => {
    expect(stashBaseJump("base", inGraph, new Set(["base"]))).toBe("go");
  });

  it("表示を絞っていて行が無ければ hidden", () => {
    expect(stashBaseJump("filtered", inGraph, new Set(["base"]))).toBe("hidden");
  });

  it("読み込んだ集合に無ければ outside（消したブランチの上など）", () => {
    expect(stashBaseJump("gone", inGraph, new Set(["base"]))).toBe("outside");
  });
});

describe("stashReview", () => {
  it("追跡ぶんを見ているときは、元のコミット → stash を対象にする", () => {
    expect(stashReview(entry(), "tracked")).toEqual({
      kind: "ok",
      source: { kind: "range", parent: "base", sha: "w", symmetric: false },
    });
  });

  it("未追跡ぶんを見ているときは対象にしない", () => {
    expect(stashReview(entry({ untracked: "u" }), "untracked")).toEqual({ kind: "untracked" });
  });
});

describe("stillStashed", () => {
  const entries = [entry({ sha: "a" }), entry({ sha: "b" })];

  it("SHA が一覧に残っていればそのまま", () => {
    // 番号（stash@{n}）は足すたびにずれるので、SHA で引く。
    expect(stillStashed(entries, "b")).toBe("b");
  });

  it("消えていれば null", () => {
    expect(stillStashed(entries, "gone")).toBeNull();
  });

  it("選んでいなければ null", () => {
    expect(stillStashed(entries, null)).toBeNull();
  });
});

describe("stashFileKey", () => {
  it("段とパスを読み戻せる。パスのコロンも残る", () => {
    const key = stashFileKey("untracked", "a:b/c.txt");

    expect(parseStashFileKey(key)).toEqual({ section: "untracked", path: "a:b/c.txt" });
  });

  it("追跡ぶんのキーも読み戻せる", () => {
    expect(parseStashFileKey(stashFileKey("tracked", "x.txt"))).toEqual({
      section: "tracked",
      path: "x.txt",
    });
  });
});
