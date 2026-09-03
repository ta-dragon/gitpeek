import { describe, expect, it } from "vitest";

import type { FileChange, WorkingTree } from "./ipc";
import {
  entryKey,
  isClean,
  parseKey,
  sectionEntries,
  stillListed,
  summarize,
  workingEntries,
} from "./workingTree";

function change(path: string): FileChange {
  return {
    path,
    oldPath: null,
    status: "modified",
    additions: 1,
    deletions: 0,
    oldMode: "100644",
    newMode: "100644",
  };
}

function tree(partial: Partial<WorkingTree> = {}): WorkingTree {
  return {
    staged: [],
    unstaged: [],
    untracked: [],
    unmerged: [],
    indexLockPresent: false,
    ...partial,
  };
}

describe("workingEntries", () => {
  // 直さないと先へ進めないので、衝突は下に埋もれさせない。
  it("衝突を先頭に置き、残りは決めた順に並べる", () => {
    const entries = workingEntries(
      tree({
        staged: [change("s.txt")],
        unstaged: [change("u.txt")],
        untracked: ["n.txt"],
        unmerged: ["c.txt"],
      }),
    );

    expect(entries.map((entry) => entry.section)).toEqual([
      "unmerged",
      "staged",
      "unstaged",
      "untracked",
    ]);
    expect(entries.map((entry) => entry.path)).toEqual(["c.txt", "s.txt", "u.txt", "n.txt"]);
  });

  it("未追跡と衝突は差分を持たない", () => {
    const entries = workingEntries(tree({ untracked: ["n.txt"], unmerged: ["c.txt"] }));
    expect(entries.every((entry) => entry.change === null)).toBe(true);
  });

  it("空なら空", () => {
    expect(workingEntries(null)).toEqual([]);
    expect(workingEntries(tree())).toEqual([]);
  });
});

describe("entryKey", () => {
  // `git add` のあとにもう一度直せば、同じパスが両方のセクションに出る。
  it("同じパスでもセクションが違えば別の鍵になる", () => {
    const staged = entryKey({ section: "staged", path: "a.txt" });
    const unstaged = entryKey({ section: "unstaged", path: "a.txt" });
    expect(staged).not.toBe(unstaged);
  });

  it("鍵から選択へ戻せる", () => {
    const selection = { section: "untracked" as const, path: "sub/未追跡.txt" };
    expect(parseKey(entryKey(selection))).toEqual(selection);
  });

  it("壊れた鍵は null", () => {
    expect(parseKey("a.txt")).toBeNull();
    expect(parseKey("なにか\na.txt")).toBeNull();
  });
});

describe("isClean", () => {
  it("どれか 1 つでもあれば汚れている", () => {
    expect(isClean(tree())).toBe(true);
    expect(isClean(null)).toBe(true);
    expect(isClean(tree({ untracked: ["n.txt"] }))).toBe(false);
    expect(isClean(tree({ unmerged: ["c.txt"] }))).toBe(false);
  });
});

describe("sectionEntries", () => {
  it("セクションごとの中身だけを返す", () => {
    const state = tree({ staged: [change("s.txt")], unstaged: [change("u.txt")] });
    expect(sectionEntries(state, "staged").map((entry) => entry.path)).toEqual(["s.txt"]);
    expect(sectionEntries(state, "untracked")).toEqual([]);
  });
});

describe("summarize", () => {
  it("セクションごとの件数を数える", () => {
    const state = tree({ staged: [change("a"), change("b")], untracked: ["c"] });
    expect(summarize(state)).toEqual({ staged: 2, unstaged: 0, untracked: 1, unmerged: 0 });
  });
});

describe("stillListed", () => {
  // 外部で `git add` されると、選んでいた行がセクションごと消える。
  it("セクションが変わった選択は残っていない扱いにする", () => {
    const entries = workingEntries(tree({ staged: [change("a.txt")] }));
    expect(stillListed(entries, { section: "staged", path: "a.txt" })).toBe(true);
    expect(stillListed(entries, { section: "unstaged", path: "a.txt" })).toBe(false);
    expect(stillListed(entries, null)).toBe(false);
  });
});
