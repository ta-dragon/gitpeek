import { describe, expect, it } from "vitest";

import {
  compareChoices,
  compareCounts,
  compareDefaults,
  compareReadiness,
  refsAt,
} from "./branchCompare";
import type { RefEntry } from "./ipc";

function ref(shortName: string, kind: RefEntry["kind"] = "localBranch", target?: string): RefEntry {
  const prefix =
    kind === "tag" ? "refs/tags/" : kind === "remoteBranch" ? "refs/remotes/" : "refs/heads/";
  return {
    name: `${prefix}${shortName}`,
    shortName,
    kind,
    target: target ?? `sha-${shortName}`,
    upstream: null,
    outOfGraph: false,
    orphan: false,
  };
}

/** `[sha, 親…]` の並びからコミットの索引を作る。 */
function graph(rows: string[][]): Map<string, { parents: string[] }> {
  return new Map(rows.map(([sha, ...parents]) => [sha, { parents }]));
}

describe("compareDefaults", () => {
  const refs = [ref("main"), ref("feature"), ref("origin/main", "remoteBranch")];

  it("押した ref を比較先、幹を比較元にする", () => {
    expect(compareDefaults(refs[1], refs, "refs/heads/main", "feature")).toEqual({
      from: "refs/heads/main",
      to: "refs/heads/feature",
    });
  });

  it("幹そのものを押したら、HEAD のブランチを比較元にする", () => {
    // 幹と幹を比べても空になるだけ。
    expect(compareDefaults(refs[0], refs, "refs/heads/main", "feature")).toEqual({
      from: "refs/heads/feature",
      to: "refs/heads/main",
    });
  });

  it("HEAD も幹なら比較元を空欄で開く", () => {
    expect(compareDefaults(refs[0], refs, "refs/heads/main", "main")).toEqual({
      from: null,
      to: "refs/heads/main",
    });
  });

  it("幹が決まらなければ HEAD のブランチを使う", () => {
    expect(compareDefaults(refs[2], refs, null, "feature").from).toBe("refs/heads/feature");
  });

  it("detached で幹も無ければ空欄", () => {
    expect(compareDefaults(refs[1], refs, null, null).from).toBeNull();
  });

  it("一覧に無い幹の名前は入れない", () => {
    // 入れると、選べない値が選ばれたまま「比べる」を押せてしまう。
    expect(compareDefaults(refs[1], refs, "refs/heads/gone", null).from).toBeNull();
  });
});

describe("compareReadiness", () => {
  const refs = [
    ref("main"),
    ref("feature"),
    ref("origin/main", "remoteBranch", "sha-main"),
    ref("v1.0", "tag"),
  ];

  it("両端が揃って別のコミットなら、SHA で返す", () => {
    expect(
      compareReadiness({ from: "refs/heads/main", to: "refs/tags/v1.0" }, refs),
    ).toEqual({ kind: "ready", from: "sha-main", to: "sha-v1.0" });
  });

  it("片方が空なら押せない", () => {
    expect(compareReadiness({ from: null, to: "refs/heads/main" }, refs)).toEqual({
      kind: "missing",
    });
  });

  it("一覧から消えた名前は空と同じ扱い", () => {
    expect(compareReadiness({ from: "refs/heads/gone", to: "refs/heads/main" }, refs).kind).toBe(
      "missing",
    );
  });

  it("同じ ref 同士は押せない", () => {
    expect(
      compareReadiness({ from: "refs/heads/main", to: "refs/heads/main" }, refs).kind,
    ).toBe("sameRef");
  });

  it("別の ref でも同じコミットを指していれば押せない", () => {
    // 差分が空になるだけで、比較の見た目だけが残る。
    expect(
      compareReadiness({ from: "refs/remotes/origin/main", to: "refs/heads/main" }, refs).kind,
    ).toBe("sameCommit");
  });
});

describe("compareChoices", () => {
  const refs = [
    ref("v1.0", "tag"),
    ref("origin/main", "remoteBranch"),
    ref("zeta"),
    ref("Feature/Login"),
  ];

  it("ローカル → リモート → タグ、その中は名前順", () => {
    expect(compareChoices(refs, "", null).map((entry) => entry.shortName)).toEqual([
      "Feature/Login",
      "zeta",
      "origin/main",
      "v1.0",
    ]);
  });

  it("短い名前の部分一致で絞る（大文字小文字を区別しない）", () => {
    expect(compareChoices(refs, " login ", null).map((entry) => entry.shortName)).toEqual([
      "Feature/Login",
    ]);
  });

  it("選んでいるものは絞り込みで消さない", () => {
    expect(
      compareChoices(refs, "login", "refs/tags/v1.0").map((entry) => entry.shortName),
    ).toEqual(["Feature/Login", "v1.0"]);
  });
});

describe("refsAt", () => {
  it("その SHA を指す ref を、ローカル → リモート → タグの順で返す", () => {
    const refs = [
      ref("v1.0", "tag", "x"),
      ref("origin/main", "remoteBranch", "x"),
      ref("main", "localBranch", "x"),
      ref("other", "localBranch", "y"),
    ];

    expect(refsAt("x", refs)).toEqual(["main", "origin/main", "v1.0"]);
  });

  it("どれも指していなければ空", () => {
    // fetch で ref が動いたあと。名前は消えて SHA だけが残る。
    expect(refsAt("z", [ref("main", "localBranch", "x")])).toEqual([]);
  });
});

describe("compareCounts", () => {
  //   f2   m2
  //   |    |
  //   f1   m1
  //    \  /
  //     b
  const forked = graph([["m2", "m1"], ["f2", "f1"], ["m1", "b"], ["f1", "b"], ["b"]]);

  it("分かれた 2 本は、両側に片側だけのコミットがある", () => {
    expect(compareCounts(forked, "m2", "f2")).toEqual({
      kind: "counted",
      onlyInFrom: 2,
      onlyInTo: 2,
    });
  });

  it("比較元が祖先なら、比較先の側だけに数が付く", () => {
    expect(compareCounts(forked, "b", "f2")).toEqual({
      kind: "counted",
      onlyInFrom: 0,
      onlyInTo: 2,
    });
  });

  it("同じコミットなら 0 と 0", () => {
    expect(compareCounts(forked, "m1", "m1")).toEqual({
      kind: "counted",
      onlyInFrom: 0,
      onlyInTo: 0,
    });
  });

  it("マージで取り込んだ側のコミットは、片側だけに数えない", () => {
    //   x (m2 と f2 のマージ)
    const merged = graph([["x", "m2", "f2"], ...[...forked].map(([sha, c]) => [sha, ...c.parents])]);

    // x には f1, f2 も入っているので、f2 → x で増えるのは m1, m2, x の 3 つ。
    expect(compareCounts(merged, "f2", "x")).toEqual({
      kind: "counted",
      onlyInFrom: 0,
      onlyInTo: 3,
    });
  });

  it("どちらかが読み込んだ集合の外なら数えられない", () => {
    expect(compareCounts(forked, "m2", "zzz")).toEqual({ kind: "unknown" });
    expect(compareCounts(forked, "zzz", "m2")).toEqual({ kind: "unknown" });
  });

  it("手元に無い親はそこで止める", () => {
    // 読み込んだ範囲の端（親が集合の外）。
    const partial = graph([["a2", "a1"], ["a1", "outside"]]);

    expect(compareCounts(partial, "a1", "a2")).toEqual({
      kind: "counted",
      onlyInFrom: 0,
      onlyInTo: 1,
    });
  });
});
