import { describe, expect, it } from "vitest";

import type { DiffLine, Finding, Hunk, ReviewFileResult, ReviewRun, Severity } from "./ipc";
import {
  bySeverity,
  countFindings,
  findingsFor,
  landsOn,
  newLines,
  outcomeOf,
  placeFindings,
} from "./reviewFindings";

function finding(extra: Partial<Finding> = {}): Finding {
  return {
    file: "a.ts",
    line: 1,
    severity: "info",
    title: "見出し",
    message: "本文",
    ...extra,
  };
}

function line(newLine: number | null, oldLine: number | null = null): DiffLine {
  return {
    kind: newLine === null ? "removed" : "added",
    oldLine,
    newLine,
    text: "x",
    ending: "lf",
  };
}

function hunk(lines: DiffLine[]): Hunk {
  return { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, heading: "", lines };
}

function result(extra: Partial<ReviewFileResult> = {}): ReviewFileResult {
  return {
    path: "a.ts",
    oldPath: null,
    parts: 1,
    text: { summary: "", findings: [], markdown: null, fallbackReason: null },
    error: null,
    tokensEstimate: 1,
    elapsedMs: 1,
    ...extra,
  };
}

function run(files: ReviewFileResult[]): ReviewRun {
  return {
    runId: "r",
    profileId: "p",
    model: "m",
    source: { kind: "workingTree", staged: false },
    skills: [],
    files,
    summary: null,
    failed: 0,
    cancelled: false,
    startedAt: 0,
    elapsedMs: 0,
  };
}

describe("bySeverity", () => {
  it("重いものから並べる", () => {
    const order: Severity[] = ["info", "critical", "minor", "major"];
    const sorted = bySeverity(order.map((severity) => finding({ severity })));
    expect(sorted.map((it) => it.severity)).toEqual(["critical", "major", "minor", "info"]);
  });

  it("同じ重さなら元の順を保つ", () => {
    const sorted = bySeverity([
      finding({ severity: "major", title: "1 番目" }),
      finding({ severity: "major", title: "2 番目" }),
    ]);
    expect(sorted.map((it) => it.title)).toEqual(["1 番目", "2 番目"]);
  });

  // 端の値: 0 件。
  it("0 件でも落ちない", () => {
    expect(bySeverity([])).toEqual([]);
  });
});

describe("placeFindings", () => {
  const hunks = [hunk([line(10, 10), line(11, null), line(12, 12)])];

  it("差分にある行へ付ける", () => {
    const placed = placeFindings([finding({ line: 11 })], hunks);
    expect(placed.byLine.get(11)).toHaveLength(1);
    expect(placed.offDiff).toEqual([]);
    expect(placed.whole).toEqual([]);
  });

  /**
   * **差分に無い行の指摘にはバッジを出さない。** モデルは差分に現れない
   * 行番号をよく書く。無い行に出すと別の行の指摘に見える。
   */
  it("差分に無い行の指摘は残すが行には付けない", () => {
    const placed = placeFindings([finding({ line: 999 })], hunks);
    expect(placed.byLine.size).toBe(0);
    expect(placed.offDiff).toHaveLength(1);
  });

  it("行を指していない指摘はファイル全体への指摘にする", () => {
    const placed = placeFindings([finding({ line: null })], hunks);
    expect(placed.whole).toHaveLength(1);
    expect(placed.byLine.size).toBe(0);
    expect(placed.offDiff).toEqual([]);
  });

  it("同じ行に 2 件あっても落とさない", () => {
    const placed = placeFindings(
      [finding({ line: 10, title: "1 件目" }), finding({ line: 10, title: "2 件目" })],
      hunks,
    );
    expect(placed.byLine.get(10)?.map((it) => it.title)).toEqual(["1 件目", "2 件目"]);
  });

  /**
   * 削除された行は変更後の行番号を持たないので、行に付けようが無い。
   * **`offDiff` へ落として理由を出す。**
   */
  it("削除された行だけを指した指摘は行に付かない", () => {
    const removed = [hunk([line(null, 5)])];
    const placed = placeFindings([finding({ line: 5 })], removed);
    expect(placed.byLine.size).toBe(0);
    expect(placed.offDiff).toHaveLength(1);
  });

  // 端の値: 指摘 0 件 / 差分が空。
  it("指摘 0 件でも差分が空でも落ちない", () => {
    expect(placeFindings([], hunks).byLine.size).toBe(0);
    const placed = placeFindings([finding({ line: 1 })], []);
    expect(placed.offDiff).toHaveLength(1);
    expect(placed.byLine.size).toBe(0);
  });
});

describe("findingsFor", () => {
  /**
   * **`finding.file` ではなく入れ物のパスで引く。** モデルが書いた `file` は
   * 当てにならない（別のパスを書くことがある）。
   */
  it("入れ物のパスで引き、モデルが書いた file を信用しない", () => {
    const target = run([
      result({
        path: "a.ts",
        text: {
          summary: "",
          findings: [finding({ file: "まったく別のパス.ts" })],
          markdown: null,
          fallbackReason: null,
        },
      }),
    ]);
    expect(findingsFor(target, "a.ts")).toHaveLength(1);
    expect(findingsFor(target, "まったく別のパス.ts")).toEqual([]);
  });

  it("結果の無いファイルは空", () => {
    expect(findingsFor(run([result({ text: null })]), "a.ts")).toEqual([]);
    expect(findingsFor(run([]), "a.ts")).toEqual([]);
  });
});

describe("countFindings", () => {
  it("ファイルをまたいで数える", () => {
    const target = run([
      result({
        path: "a.ts",
        text: { summary: "", findings: [finding(), finding()], markdown: null, fallbackReason: null },
      }),
      result({
        path: "b.ts",
        text: { summary: "", findings: [finding()], markdown: null, fallbackReason: null },
      }),
    ]);
    expect(countFindings(target)).toBe(3);
  });

  it("結果が無くても 0 で数える", () => {
    expect(countFindings(run([result({ text: null }), result({ error: null })]))).toBe(0);
    expect(countFindings(run([]))).toBe(0);
  });
});

describe("outcomeOf", () => {
  it("成功・構造化に失敗・通信の失敗・空を言い分ける", () => {
    expect(outcomeOf(result())).toBe("ok");
    expect(
      outcomeOf(
        result({
          text: { summary: "", findings: [], markdown: "生出力", fallbackReason: "だめでした" },
        }),
      ),
    ).toBe("fallback");
    expect(
      outcomeOf(result({ error: { kind: "status", message: "落ちました", detail: "" } })),
    ).toBe("failed");
    expect(outcomeOf(result({ text: null }))).toBe("empty");
  });

  /**
   * **通信の失敗と「構造化に失敗」を混ぜない。** 両方あるときは
   * 通信の失敗のほうが先（そもそも本文が無い）。
   */
  it("通信に失敗していれば構造化の失敗より先に出す", () => {
    const both = result({
      error: { kind: "status", message: "落ちました", detail: "" },
      text: { summary: "", findings: [], markdown: "途中まで", fallbackReason: "切れました" },
    });
    expect(outcomeOf(both)).toBe("failed");
  });
});

describe("newLines", () => {
  it("変更後の行番号だけを集める", () => {
    expect([...newLines([hunk([line(3), line(null, 4), line(5)])])].sort()).toEqual([3, 5]);
  });

  // 端の値: hunk が無い（リネームだけの差分など）。
  it("hunk が無ければ空", () => {
    expect(newLines([]).size).toBe(0);
  });
});

describe("landsOn", () => {
  const lookup = { path: "a.ts", lines: new Set([3, 5]) };

  it("開いているファイルの行なら当たる・当たらないを言う", () => {
    expect(landsOn(lookup, "a.ts", 3)).toBe(true);
    expect(landsOn(lookup, "a.ts", 4)).toBe(false);
  });

  // **開いていないファイルのことは分からない。** 「当たらなかった」と書くと嘘になる。
  it("別のファイル・何も開いていないときは分からない", () => {
    expect(landsOn(lookup, "b.ts", 3)).toBeNull();
    expect(landsOn(null, "a.ts", 3)).toBeNull();
  });

  // 端の値: ファイル全体への指摘（行を持たない）。
  it("行を持たない指摘は分からない扱い", () => {
    expect(landsOn(lookup, "a.ts", null)).toBeNull();
  });
});
