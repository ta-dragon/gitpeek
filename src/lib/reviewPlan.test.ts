import { describe, expect, it } from "vitest";

import { ja } from "../i18n/ja";
import type { LlmProfile, PlannedFile, ReviewIndexRow, ReviewPlan } from "./ipc";
import {
  defaultSelection,
  fileNote,
  historyLabel,
  historyTime,
  initialProfile,
  planCounts,
  runGate,
  selectable,
  selectedTokens,
} from "./reviewPlan";

function file(path: string, extra: Partial<PlannedFile> = {}): PlannedFile {
  return {
    path,
    oldPath: null,
    status: "modified",
    tokensEstimate: 10,
    parts: 1,
    skipped: null,
    ...extra,
  };
}

function plan(extra: Partial<ReviewPlan> = {}): ReviewPlan {
  return {
    files: [file("a.ts"), file("b.ts")],
    skills: [{ name: "general-review", origin: "builtIn" }],
    tokensEstimate: 20,
    blocked: null,
    ...extra,
  };
}

function profile(id: string): LlmProfile {
  return {
    id,
    name: id,
    baseUrl: "http://localhost:11434/v1",
    model: "m",
    contextWindow: 32768,
    temperature: 0.2,
    maxTokens: 4096,
    credentialKey: `llm/${id}`,
  };
}

describe("runGate", () => {
  const profiles = [profile("p1")];

  it("押せるときは理由を出さない", () => {
    const gate = runGate(plan(), profiles, ["a.ts"], { running: false });
    expect(gate).toEqual({ enabled: true, reason: null });
  });

  // **押せないときも選択肢を消さない**（CLAUDE.md §6）。理由が必ず付く。
  it("計画がまだ無いときは調べている旨を出す", () => {
    const gate = runGate(null, profiles, [], { running: false });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe(ja.review.gate.noPlan);
  });

  it("Rust 側が実行できないと言った理由をそのまま出す", () => {
    const blocked = plan({ blocked: "使うレビュー観点が 1 つもありません。" });
    const gate = runGate(blocked, profiles, ["a.ts"], { running: false });
    expect(gate.reason).toBe("使うレビュー観点が 1 つもありません。");
  });

  it("接続先が無いときは接続先の理由を出す", () => {
    const gate = runGate(plan(), [], ["a.ts"], { running: false });
    expect(gate.reason).toBe(ja.review.gate.noProfile);
  });

  // **2 本走らせない。** 中止の合図が 1 つしか無いので、2 本目は止められなくなる。
  it("もう 1 本走っているときは押せない", () => {
    const gate = runGate(plan(), profiles, ["a.ts"], { running: true });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe(ja.review.gate.alreadyRunning);
  });

  it("全部外したときは選び直すよう言う", () => {
    const gate = runGate(plan(), profiles, [], { running: false });
    expect(gate.reason).toBe(ja.review.gate.nothingSelected);
  });

  /**
   * **先に効く理由を先に出す。** 接続先が無く、かつ全部外れているとき、
   * 「1 つ以上チェックしてください」だけ出すと、チェックしても押せないままで
   * 何が効いているのか読めなくなる。
   */
  it("複数の理由が重なったら、先に直すべきものを出す", () => {
    const gate = runGate(plan(), [], [], { running: false });
    expect(gate.reason).toBe(ja.review.gate.noProfile);
  });
});

describe("defaultSelection", () => {
  it("送れるファイルだけを最初から選ぶ", () => {
    const selection = defaultSelection(
      plan({ files: [file("a.ts"), file("b.png", { skipped: "バイナリです。" })] }),
    );
    expect(selection).toEqual(["a.ts"]);
  });

  it("計画が無ければ空", () => {
    expect(defaultSelection(null)).toEqual([]);
  });

  // 端の値: 送れるファイルが 1 つも無い。
  it("送れるものが無ければ空", () => {
    const none = plan({ files: [file("a.png", { skipped: "バイナリです。" })] });
    expect(defaultSelection(none)).toEqual([]);
  });
});

describe("selectable / fileNote", () => {
  it("送らないファイルは操作させず、理由をそのまま出す", () => {
    const skipped = file("a.png", { skipped: "バイナリなので差分を読めません。" });
    expect(selectable(skipped)).toBe(false);
    expect(fileNote(skipped)).toBe("バイナリなので差分を読めません。");
  });

  // **用語をそのまま出さない。**「hunk 分割」ではなく何が起きるかを書く。
  it("分けて送るファイルには回数を添える", () => {
    expect(fileNote(file("big.ts", { parts: 3 }))).toBe(ja.review.plan.splitInto(3));
    expect(fileNote(file("big.ts", { parts: 3 }))).toContain("3 回");
  });

  it("普通のファイルには何も添えない", () => {
    expect(fileNote(file("a.ts"))).toBeNull();
    expect(selectable(file("a.ts"))).toBe(true);
  });
});

describe("planCounts / selectedTokens", () => {
  it("送るものと送らないものを数える", () => {
    const counted = planCounts(
      plan({ files: [file("a.ts"), file("b.png", { skipped: "バイナリです。" })] }),
    );
    expect(counted).toEqual({ sending: 1, skipped: 1 });
  });

  it("計画が無ければ 0 件", () => {
    expect(planCounts(null)).toEqual({ sending: 0, skipped: 0 });
    expect(selectedTokens(null, ["a.ts"])).toBe(0);
  });

  // **Rust の数を足すだけ。** 文字数から数え直さない。
  it("選んだファイルぶんだけ足す", () => {
    const target = plan({
      files: [
        file("a.ts", { tokensEstimate: 100 }),
        file("b.ts", { tokensEstimate: 30 }),
        file("c.png", { tokensEstimate: 999, skipped: "バイナリです。" }),
      ],
    });
    expect(selectedTokens(target, ["a.ts"])).toBe(100);
    expect(selectedTokens(target, ["a.ts", "b.ts"])).toBe(130);
    // 送らないファイルは選ばれていても数えない。
    expect(selectedTokens(target, ["a.ts", "c.png"])).toBe(100);
    expect(selectedTokens(target, [])).toBe(0);
  });
});

describe("initialProfile", () => {
  it("リポジトリの既定があればそれを選ぶ", () => {
    expect(initialProfile([profile("p1"), profile("p2")], "p2")).toBe("p2");
  });

  // **消えた接続先を指したまま残さない。**
  it("既定が消えていたら選ばない", () => {
    expect(initialProfile([profile("p1"), profile("p2")], "gone")).toBeNull();
  });

  it("1 つしか無ければそれを選ぶ", () => {
    expect(initialProfile([profile("p1")], null)).toBe("p1");
  });

  // **勝手に 1 つ目を選ばない。** 選ばれているように見えて別の接続先へ投げるより、
  // 選んでもらうほうがよい。
  it("複数あって既定が無ければ選ばない", () => {
    expect(initialProfile([profile("p1"), profile("p2")], null)).toBeNull();
  });

  it("1 つも無ければ選ばない", () => {
    expect(initialProfile([], "p1")).toBeNull();
  });
});

describe("historyLabel", () => {
  function row(extra: Partial<ReviewIndexRow> = {}): ReviewIndexRow {
    return {
      file: "a.json",
      savedAt: "2026-09-06T12:04:31+09:00",
      model: "m",
      profileName: "ローカル",
      source: null,
      files: 3,
      findings: 5,
      failed: 0,
      cancelled: false,
      unreadable: null,
      ...extra,
    };
  }

  it("指摘の件数を出す", () => {
    expect(historyLabel(row())).toBe(ja.review.history.findings(5));
  });

  // 端の値: 指摘 0 件。**「0 件」と出す**（空欄にすると失敗と区別が付かない）。
  it("指摘 0 件でも件数を出す", () => {
    expect(historyLabel(row({ findings: 0 }))).toContain("0");
  });

  it("失敗と中止は必ず出す", () => {
    const label = historyLabel(row({ failed: 2, cancelled: true }));
    expect(label).toContain(ja.review.history.failed(2));
    expect(label).toContain(ja.review.history.cancelled);
  });

  // **読めないものも一覧から消さない。**
  it("読めない行はそう言う", () => {
    expect(historyLabel(row({ unreadable: "JSON として読めません。" }))).toBe(
      ja.review.history.unreadable,
    );
  });
});

describe("historyTime", () => {
  it("読める時刻は年月日と時分にする", () => {
    expect(historyTime("2026-09-06T12:04:31+09:00")).toMatch(/^2026-09-06 \d\d:\d\d$/);
  });

  // **読めない値でも落とさない。** 手で置かれたファイルでも一覧は出す。
  it("読めない値はそのまま返す", () => {
    expect(historyTime("こわれている")).toBe("こわれている");
    expect(historyTime("")).toBe("");
  });
});
