import { describe, expect, it } from "vitest";

import type { RepoTrustStatus, SkillEntry, SkillState } from "./ipc";
import {
  countSkills,
  skillDisplay,
  skillsToReview,
  trustOption,
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
    preview: "本文",
    ...overrides,
  };
}

function status(overrides: Partial<RepoTrustStatus> = {}): RepoTrustStatus {
  return {
    present: true,
    trusted: false,
    needsRecheck: false,
    changed: [],
    added: [],
    ...overrides,
  };
}

describe("trustOption", () => {
  /** **どの状態でもボタンを消さない。** 押せない理由が必ず付くこと。 */
  it("リポジトリを開いていなければ何も押せない", () => {
    expect(trustOption(status(), false)).toEqual({
      kind: "noRepository",
      canTrust: false,
      canUntrust: false,
    });
  });

  it("skill が無ければ信頼できない", () => {
    expect(trustOption(status({ present: false }), true)).toEqual({
      kind: "noSkills",
      canTrust: false,
      canUntrust: false,
    });
  });

  /**
   * ファイルを消したあとも記録は残る。**取り消せないと、信頼が残っていることに
   * 気付けない**（あとで置き直したファイルが即座に効いてしまう）。
   */
  it("skill が無くても、信頼の記録が残っていれば取り消せる", () => {
    expect(trustOption(status({ present: false, trusted: true }), true)).toEqual({
      kind: "noSkills",
      canTrust: false,
      canUntrust: true,
    });
  });

  it("未信頼なら信頼できる", () => {
    expect(trustOption(status(), true)).toEqual({
      kind: "untrusted",
      canTrust: true,
      canUntrust: false,
    });
  });

  it("変わっていれば確認し直せるし、取り消しもできる", () => {
    expect(
      trustOption(status({ trusted: true, needsRecheck: true, added: ["evil.md"] }), true),
    ).toEqual({ kind: "recheck", canTrust: true, canUntrust: true });
  });

  it("信頼済みで変化が無ければ取り消しだけ", () => {
    expect(trustOption(status({ trusted: true }), true)).toEqual({
      kind: "trusted",
      canTrust: false,
      canUntrust: true,
    });
  });
});

describe("skillsToReview", () => {
  /** **読めないものも見せる。** 隠すと「1 つ増えた」に気付けないまま信頼する。 */
  it("リポジトリ内のものを、読める読めないに関わらず全部返す", () => {
    const entries = [
      entry({ origin: "builtIn", file: "" }),
      entry({ origin: "global" }),
      entry({ origin: "repository", file: "a.md" }),
      entry({
        origin: "repository",
        file: "broken.md",
        state: { kind: "unreadable", reason: "本文がありません" },
      }),
    ];
    expect(skillsToReview(entries).map((item) => item.file)).toEqual([
      "a.md",
      "broken.md",
    ]);
  });

  it("リポジトリ内が無ければ空", () => {
    expect(skillsToReview([entry({ origin: "builtIn" })])).toEqual([]);
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
    const counts = countSkills(states.map((state) => entry({ state })));
    expect(counts).toEqual({ usable: 1, untrusted: 1, recheck: 1, unreadable: 1 });
  });

  /** **隠されたものを「使える」に数えない。** 数と実際に効くものがずれる。 */
  it("同名で押しのけられたものは使えるに数えない", () => {
    const counts = countSkills([
      entry({ shadowedBy: "repository" }),
      entry({ origin: "repository" }),
    ]);
    expect(counts.usable).toBe(1);
  });

  it("空なら全部 0", () => {
    expect(countSkills([])).toEqual({
      usable: 0,
      untrusted: 0,
      recheck: 0,
      unreadable: 0,
    });
  });
});

describe("skillDisplay", () => {
  it("読めて押しのけられていなければ効いている", () => {
    const display = skillDisplay(entry());
    expect(display.effective).toBe(true);
    expect(display.reason).toBeNull();
    expect(display.shadowedBy).toBeNull();
  });

  /** **「読めているのに効かない」を黙って見せない。** */
  it("押しのけられていれば、読めていても効かない", () => {
    const display = skillDisplay(entry({ shadowedBy: "repository" }));
    expect(display.effective).toBe(false);
    expect(display.shadowedBy).toBe("repository");
    expect(display.reason).toBeNull();
  });

  it("未信頼は効かない", () => {
    expect(skillDisplay(entry({ state: { kind: "untrusted" } })).effective).toBe(false);
  });

  it("読めないときは理由を出す", () => {
    const display = skillDisplay(
      entry({ state: { kind: "unreadable", reason: "本文がありません" } }),
    );
    expect(display.effective).toBe(false);
    expect(display.reason).toBe("本文がありません");
  });

  it("内蔵は編集できない", () => {
    expect(skillDisplay(entry({ origin: "builtIn" })).editable).toBe(false);
    expect(skillDisplay(entry({ origin: "global" })).editable).toBe(true);
    expect(skillDisplay(entry({ origin: "repository" })).editable).toBe(true);
  });
});
