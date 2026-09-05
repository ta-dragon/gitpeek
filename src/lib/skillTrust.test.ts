import { describe, expect, it } from "vitest";

import type { SkillEntry, SkillState } from "./ipc";
import {
  countSkills,
  extraChanged,
  skillDisplay,
  skillsFrom,
  targetOf,
  useAction,
} from "./skillTrust";

function entry(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name: "review",
    description: "テスト用",
    globs: [],
    enabled: true,
    origin: "global",
    file: "review.md",
    state: { kind: "ready" },
    shadowedBy: null,
    inUse: true,
    decidedByUser: false,
    extra: "",
    hash: "abc123",
    preview: "本文",
    ...overrides,
  };
}

describe("useAction", () => {
  it("使っているものは止められる", () => {
    expect(useAction(entry())).toEqual({ kind: "stop", enabled: true, next: false });
  });

  it("使っていないものは使える", () => {
    expect(useAction(entry({ inUse: false }))).toEqual({
      kind: "use",
      enabled: true,
      next: true,
    });
  });

  /** 未決も「使っていない」なので、押せば使える。 */
  it("まだ決めていないリポジトリ内 skill は押せば使える", () => {
    expect(
      useAction(entry({ origin: "repository", inUse: false, state: { kind: "untrusted" } })),
    ).toEqual({ kind: "use", enabled: true, next: true });
  });

  it("中身が変わったものも、読み直して押せば使える", () => {
    expect(
      useAction(entry({ origin: "repository", inUse: false, state: { kind: "recheck" } })),
    ).toEqual({ kind: "use", enabled: true, next: true });
  });

  /** **押せないときも消さない**（CLAUDE.md §6）。理由が付くこと。 */
  it("読めないものは押せない", () => {
    expect(
      useAction(entry({ state: { kind: "unreadable", reason: "本文がありません" } })),
    ).toEqual({ kind: "unreadable", enabled: false, next: false });
  });

  /** **効かないものを「使う」にできると、使っているつもりで効かない。** */
  it("同名で押しのけられているものは押せない", () => {
    expect(useAction(entry({ inUse: false, shadowedBy: "repository" }))).toEqual({
      kind: "shadowed",
      enabled: false,
      next: true,
    });
  });
});

describe("targetOf", () => {
  /** **内蔵とグローバルは名前で、リポジトリ内はファイル名で指す。** */
  it("内蔵とグローバルは名前で指す", () => {
    expect(targetOf(entry({ origin: "global" }), "r1")).toEqual({
      scope: "global",
      name: "review",
    });
    expect(targetOf(entry({ origin: "builtIn", file: "" }), null)).toEqual({
      scope: "global",
      name: "review",
    });
  });

  it("リポジトリ内はファイル名で指す", () => {
    expect(targetOf(entry({ origin: "repository", file: "a.md" }), "r1")).toEqual({
      scope: "repository",
      repositoryId: "r1",
      file: "a.md",
    });
  });

  /** リポジトリを開いていないのにリポジトリ内 skill は指せない。 */
  it("リポジトリが無ければ指せない", () => {
    expect(targetOf(entry({ origin: "repository" }), null)).toBeNull();
  });
});

describe("skillsFrom", () => {
  const entries = [
    entry({ origin: "builtIn", name: "built" }),
    entry({ origin: "global", name: "global" }),
    entry({ origin: "repository", name: "repo" }),
  ];

  /** **画面が 2 つに分かれた**ので、どちらも同じ関数から取る。 */
  it("設定の画面は内蔵とグローバルだけ", () => {
    expect(skillsFrom(entries, ["builtIn", "global"]).map((e) => e.name)).toEqual([
      "built",
      "global",
    ]);
  });

  it("リポジトリの設定はリポジトリ内だけ", () => {
    expect(skillsFrom(entries, ["repository"]).map((e) => e.name)).toEqual(["repo"]);
  });

  it("該当が無ければ空", () => {
    expect(skillsFrom([], ["repository"])).toEqual([]);
  });
});

describe("countSkills", () => {
  it("状態ごとに数える", () => {
    const states: SkillState[] = [
      { kind: "ready" },
      { kind: "untrusted" },
      { kind: "recheck" },
      { kind: "unreadable", reason: "だめ" },
    ];
    expect(countSkills(states.map((state) => entry({ state })))).toEqual({
      inUse: 1,
      undecided: 1,
      changed: 1,
      unreadable: 1,
    });
  });

  it("使わないと決めたものは「使う」に数えない", () => {
    expect(countSkills([entry({ inUse: false })]).inUse).toBe(0);
    expect(countSkills([entry({ inUse: false })]).undecided).toBe(1);
  });

  /** **押しのけられたものを「使う」に数えない。** 数と実際に効くものがずれる。 */
  it("同名で押しのけられたものは数えない", () => {
    expect(countSkills([entry({ shadowedBy: "repository" })]).inUse).toBe(0);
  });

  it("空なら全部 0", () => {
    expect(countSkills([])).toEqual({
      inUse: 0,
      undecided: 0,
      changed: 0,
      unreadable: 0,
    });
  });
});

describe("skillDisplay", () => {
  it("使っていて押しのけられていなければ効いている", () => {
    const display = skillDisplay(entry());
    expect(display.effective).toBe(true);
    expect(display.reason).toBeNull();
    expect(display.mustRead).toBe(false);
  });

  it("使わないと決めたものは効かない", () => {
    expect(skillDisplay(entry({ inUse: false })).effective).toBe(false);
  });

  /** **「読めているのに効かない」を黙って見せない。** */
  it("押しのけられていれば、読めていても効かない", () => {
    const display = skillDisplay(entry({ shadowedBy: "repository" }));
    expect(display.effective).toBe(false);
    expect(display.shadowedBy).toBe("repository");
  });

  it("読めないときは理由を出す", () => {
    const display = skillDisplay(
      entry({ state: { kind: "unreadable", reason: "本文がありません" } }),
    );
    expect(display.effective).toBe(false);
    expect(display.reason).toBe("本文がありません");
  });

  /** **読ませずに使わせない。** 決めていない／変わったものは本文を開いて出す。 */
  it("決めていないものと変わったものは本文を開く", () => {
    expect(skillDisplay(entry({ state: { kind: "untrusted" } })).mustRead).toBe(true);
    expect(skillDisplay(entry({ state: { kind: "recheck" } })).mustRead).toBe(true);
    expect(skillDisplay(entry({ state: { kind: "ready" } })).mustRead).toBe(false);
  });

  it("誰が決めたかを持ち回す", () => {
    expect(skillDisplay(entry({ decidedByUser: true })).decidedByUser).toBe(true);
    expect(skillDisplay(entry()).decidedByUser).toBe(false);
  });
});

describe("extraChanged", () => {
  /** **前後の空白だけの違いで settings.json を書きに行かない。** */
  it("前後の空白だけの違いは変更としない", () => {
    expect(extraChanged("一言", "  一言  ")).toBe(false);
    expect(extraChanged("", "   ")).toBe(false);
  });

  it("中身が変われば書く", () => {
    expect(extraChanged("", "一言")).toBe(true);
    expect(extraChanged("一言", "")).toBe(true);
    expect(extraChanged("一言", "別の一言")).toBe(true);
  });
});
