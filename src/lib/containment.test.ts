import { describe, expect, it } from "vitest";

import {
  autoCheckBranches,
  canCheckContainment,
  canFindContainers,
  checkProgress,
  containerRows,
  containersProgressView,
  containersSummary,
  containmentKey,
  containmentView,
  keyFor,
  nextToCheck,
  refLabel,
  resultFor,
  squashJump,
  squashOf,
  type CheckResult,
} from "./containment";
import type { Containment, ContainmentOutcome, RefEntry } from "./ipc";

function ref(name: string, target: string, extra: Partial<RefEntry> = {}): RefEntry {
  const kind: RefEntry["kind"] = name.startsWith("refs/heads/")
    ? "localBranch"
    : name.startsWith("refs/remotes/")
      ? "remoteBranch"
      : "tag";
  return {
    name,
    shortName: name.replace(/^refs\/(heads|remotes|tags)\//, ""),
    kind,
    target,
    upstream: null,
    outOfGraph: false,
    orphan: false,
    ...extra,
  };
}

const MAIN = "refs/remotes/origin/main";

const refs: RefEntry[] = [
  ref(MAIN, "t0"),
  ref("refs/heads/main", "t0", { upstream: MAIN }),
  ref("refs/heads/feature", "f1"),
  ref("refs/heads/squashed", "s1"),
  ref("refs/remotes/origin/feature", "f1"),
  ref("refs/tags/v1.0", "t0"),
];

function done(branch: string, containment: Containment): CheckResult {
  const outcome: ContainmentOutcome = {
    branch,
    target: MAIN,
    branchTip: "x",
    targetTip: "y",
    containment,
    elapsedMs: 10,
  };
  return { kind: "done", outcome };
}

/** いまの位置の鍵で結果を覚えたキャッシュ。 */
function cacheWith(entries: [string, CheckResult][], at: RefEntry[] = refs) {
  const map = new Map<string, CheckResult>();
  for (const [branch, result] of entries) {
    const key = keyFor(branch, MAIN, at);
    if (key === null) throw new Error(`鍵が無い: ${branch}`);
    map.set(key, result);
  }
  return map;
}

describe("autoCheckBranches", () => {
  it("ローカルブランチだけを、ref の並び順で返す", () => {
    const listed = autoCheckBranches(refs, MAIN);
    expect(listed).toEqual(["refs/heads/feature", "refs/heads/squashed"]);
    // リモートブランチは右クリックから 1 本ずつ。
    expect(listed).not.toContain("refs/remotes/origin/feature");
  });

  it("相手そのものは除く", () => {
    const target = "refs/heads/feature";
    expect(autoCheckBranches(refs, target)).not.toContain(target);
  });

  it("先端が相手と同じものは除く", () => {
    const same = [...refs, ref("refs/heads/copy", "t0")];
    expect(autoCheckBranches(same, MAIN)).not.toContain("refs/heads/copy");
  });

  it("読み込んだ履歴の外を指すものは除く", () => {
    const outside = [...refs, ref("refs/heads/old", "zz", { outOfGraph: true })];
    expect(autoCheckBranches(outside, MAIN)).not.toContain("refs/heads/old");
  });

  it("orphan は除く", () => {
    const orphan = [...refs, ref("refs/heads/lonely", "l1", { orphan: true })];
    expect(autoCheckBranches(orphan, MAIN)).not.toContain("refs/heads/lonely");
  });

  it("上流が相手のものは除く（ahead/behind が既に出している）", () => {
    // 先端が相手とずれていても除く。先端が同じだと別の理由で除かれてしまい、確かめにならない。
    const ahead = refs.map((entry) =>
      entry.name === "refs/heads/main" ? { ...entry, target: "m1" } : entry,
    );
    expect(autoCheckBranches(ahead, MAIN)).not.toContain("refs/heads/main");
    // 上流が別のブランチなら除かない。
    const other = ahead.map((entry) =>
      entry.name === "refs/heads/main" ? { ...entry, upstream: "refs/remotes/origin/dev" } : entry,
    );
    expect(autoCheckBranches(other, MAIN)).toContain("refs/heads/main");
  });

  it("相手が決まらない・見つからなければ何も調べない", () => {
    expect(autoCheckBranches(refs, null)).toEqual([]);
    expect(autoCheckBranches(refs, "refs/heads/gone")).toEqual([]);
  });
});

describe("鍵", () => {
  const key = keyFor("refs/heads/feature", MAIN, refs);

  it("ブランチ名・相手名・両方の先端から作る", () => {
    expect(key).toBe(containmentKey("refs/heads/feature", MAIN, "f1", "t0"));
  });

  it("ブランチの先端が動けば変わる", () => {
    const moved = refs.map((entry) =>
      entry.name === "refs/heads/feature" ? { ...entry, target: "f2" } : entry,
    );
    expect(keyFor("refs/heads/feature", MAIN, moved)).not.toBe(key);
  });

  it("相手の先端が動けば変わる", () => {
    const moved = refs.map((entry) => (entry.name === MAIN ? { ...entry, target: "t1" } : entry));
    expect(keyFor("refs/heads/feature", MAIN, moved)).not.toBe(key);
  });

  it("相手の名前が違えば変わる（先端が同じでも）", () => {
    const twin = [...refs, ref("refs/heads/trunk-copy", "t0")];
    expect(keyFor("refs/heads/feature", "refs/heads/trunk-copy", twin)).not.toBe(key);
  });

  it("どちらかが見つからなければ null", () => {
    expect(keyFor("refs/heads/gone", MAIN, refs)).toBeNull();
    expect(keyFor("refs/heads/feature", "refs/heads/gone", refs)).toBeNull();
  });
});

describe("resultFor", () => {
  it("いまの位置で覚えている結果を返す", () => {
    const result = done("refs/heads/feature", { kind: "ancestor" });
    const cache = cacheWith([["refs/heads/feature", result]]);
    expect(resultFor("refs/heads/feature", MAIN, refs, cache)).toBe(result);
  });

  it("先端が動いたら、覚えた結果は当たらない", () => {
    const cache = cacheWith([["refs/heads/feature", done("refs/heads/feature", { kind: "ancestor" })]]);
    const moved = refs.map((entry) =>
      entry.name === "refs/heads/feature" ? { ...entry, target: "f2" } : entry,
    );
    expect(resultFor("refs/heads/feature", MAIN, moved, cache)).toBeNull();
  });

  it("相手が決まらなければ null", () => {
    expect(resultFor("refs/heads/feature", null, refs, new Map())).toBeNull();
  });
});

describe("nextToCheck / checkProgress", () => {
  const queue = ["refs/heads/feature", "refs/heads/squashed"];

  it("結果の当たらない先頭の 1 本を返す", () => {
    expect(nextToCheck(queue, new Map(), MAIN, refs)).toBe("refs/heads/feature");
  });

  it("覚えているものは飛ばす", () => {
    const cache = cacheWith([["refs/heads/feature", done("refs/heads/feature", { kind: "notContained" })]]);
    expect(nextToCheck(queue, cache, MAIN, refs)).toBe("refs/heads/squashed");
  });

  it("失敗も覚えたものとして飛ばす（延々と調べ直さない）", () => {
    const cache = cacheWith([["refs/heads/feature", { kind: "failed", reason: "x" }]]);
    expect(nextToCheck(queue, cache, MAIN, refs)).toBe("refs/heads/squashed");
  });

  it("全部当たれば null", () => {
    const cache = cacheWith(
      queue.map((branch) => [branch, done(branch, { kind: "notContained" })] as [string, CheckResult]),
    );
    expect(nextToCheck(queue, cache, MAIN, refs)).toBeNull();
    expect(checkProgress(queue, cache, MAIN, refs)).toEqual({ done: 2, total: 2 });
  });

  it("消えたブランチ・相手そのものは飛ばし、数えない", () => {
    const withGone = ["refs/heads/gone", MAIN, ...queue];
    expect(nextToCheck(withGone, new Map(), MAIN, refs)).toBe("refs/heads/feature");
    expect(checkProgress(withGone, new Map(), MAIN, refs)).toEqual({ done: 0, total: 2 });
  });

  it("同じブランチが列に 2 回あっても 1 本と数える（右クリックで足したものと重なる）", () => {
    expect(checkProgress([...queue, queue[0]], new Map(), MAIN, refs).total).toBe(2);
  });

  it("相手が決まらなければ何もしない", () => {
    expect(nextToCheck(queue, new Map(), null, refs)).toBeNull();
    expect(checkProgress(queue, new Map(), null, refs)).toEqual({ done: 0, total: 0 });
  });
});

describe("containmentView", () => {
  it("種類ごとに印を分ける", () => {
    const b = "refs/heads/feature";
    expect(containmentView(done(b, { kind: "ancestor" }))).toEqual({ mark: "merged" });
    expect(containmentView(done(b, { kind: "contained", squash: "sq" }))).toEqual({
      mark: "contained",
      squash: "sq",
    });
    expect(containmentView(done(b, { kind: "contained", squash: null }))).toEqual({
      mark: "contained",
      squash: null,
    });
    expect(
      containmentView(done(b, { kind: "partial", upto: 3, total: 4, squash: "sq" })),
    ).toEqual({ mark: "partial", upto: 3, total: 4, squash: "sq" });
    expect(containmentView(done(b, { kind: "squashedThenChanged", squash: "sq" }))).toEqual({
      mark: "changed",
      squash: "sq",
    });
  });

  it("入っていなければ印を出さない", () => {
    expect(containmentView(done("refs/heads/feature", { kind: "notContained" }))).toBeNull();
  });

  it("失敗は印として出す（黙って印が無いと「入っていない」と読める）", () => {
    expect(containmentView({ kind: "failed", reason: "git が落ちた" })).toEqual({
      mark: "failed",
      reason: "git が落ちた",
    });
  });

  it("まだ調べていなければ null", () => {
    expect(containmentView(null)).toBeNull();
  });
});

describe("squashOf / squashJump", () => {
  it("squash のある種類だけ飛び先を持つ", () => {
    expect(squashOf({ mark: "contained", squash: "sq" })).toBe("sq");
    expect(squashOf({ mark: "partial", upto: 1, total: 2, squash: "sq" })).toBe("sq");
    expect(squashOf({ mark: "changed", squash: "sq" })).toBe("sq");
    expect(squashOf({ mark: "contained", squash: null })).toBeNull();
    expect(squashOf({ mark: "merged" })).toBeNull();
    expect(squashOf({ mark: "failed", reason: "x" })).toBeNull();
    expect(squashOf(null)).toBeNull();
  });

  it("行が無ければ hidden（相手をグラフから外している）", () => {
    const shown = new Set(["sq"]);
    expect(squashJump("sq", shown)).toBe("go");
    expect(squashJump("other", shown)).toBe("hidden");
    expect(squashJump(null, shown)).toBe("none");
  });
});

describe("右クリック", () => {
  const byName = (name: string) => {
    const found = refs.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(name);
    return found;
  };

  it("ブランチなら押せる（ローカルもリモートも）", () => {
    expect(canCheckContainment(byName("refs/heads/feature"), MAIN).enabled).toBe(true);
    expect(canCheckContainment(byName("refs/remotes/origin/feature"), MAIN).enabled).toBe(true);
  });

  it("押せない理由を 4 種類で言い分ける", () => {
    expect(canCheckContainment(byName("refs/tags/v1.0"), MAIN).why).toBe("tag");
    expect(canCheckContainment(ref("refs/heads/old", "zz", { outOfGraph: true }), MAIN).why).toBe(
      "outOfGraph",
    );
    expect(canCheckContainment(byName("refs/heads/feature"), null).why).toBe("noTarget");
    expect(canCheckContainment(byName(MAIN), MAIN).why).toBe("isTarget");
  });

  it("取り込んでいるブランチを調べるほうは、幹そのものでも押せる（相手を選ばないので）", () => {
    expect(canFindContainers(byName("refs/heads/feature")).enabled).toBe(true);
    expect(canFindContainers(byName("refs/remotes/origin/feature")).enabled).toBe(true);
    expect(canFindContainers(byName(MAIN)).enabled).toBe(true);
    expect(canFindContainers(byName("refs/tags/v1.0")).why).toBe("tag");
    expect(canFindContainers(ref("refs/heads/old", "zz", { outOfGraph: true })).why).toBe(
      "outOfGraph",
    );
  });
});

describe("refLabel", () => {
  it("一覧にあれば短い名前、無ければ接頭辞を落とす", () => {
    expect(refLabel(refs, MAIN)).toBe("origin/main");
    expect(refLabel(refs, "refs/heads/gone")).toBe("gone");
  });
});

describe("containersProgressView", () => {
  it("残りの目安は 1 本あたりの時間 × 残りの本数", () => {
    // 4 本を 2 秒 → 1 本 0.5 秒。残り 6 本で 3 秒。
    expect(containersProgressView(4, 10, 2000)).toEqual({ done: 4, total: 10, remainingSeconds: 3 });
  });

  it("端数は切り上げる（0 秒と出して止まって見せない）", () => {
    expect(containersProgressView(3, 4, 100).remainingSeconds).toBe(1);
  });

  it("1 本も終わっていなければ目安を出さない", () => {
    expect(containersProgressView(0, 10, 5000).remainingSeconds).toBeNull();
  });

  it("終わったら 0、相手が 0 本なら出さない", () => {
    expect(containersProgressView(10, 10, 5000).remainingSeconds).toBe(0);
    expect(containersProgressView(0, 0, 0).remainingSeconds).toBeNull();
  });
});

describe("containersSummary", () => {
  const outcome = done("refs/heads/feature", { kind: "ancestor" });

  it("中止したら、見つかったかどうかより先に「全部ではない」を出す", () => {
    expect(containersSummary({ total: 10, checked: 3, found: [], cancelled: true })).toEqual({
      kind: "cancelled",
      count: 0,
      checked: 3,
      total: 10,
    });
  });

  it("相手が 1 本も無い・見つからない・見つかった を言い分ける", () => {
    expect(containersSummary({ total: 0, checked: 0, found: [], cancelled: false }).kind).toBe(
      "noCandidates",
    );
    expect(containersSummary({ total: 4, checked: 4, found: [], cancelled: false })).toEqual({
      kind: "none",
      checked: 4,
    });
    expect(containersSummary({ total: 4, checked: 4, found: [outcome], cancelled: false })).toEqual({
      kind: "found",
      count: 1,
      checked: 4,
    });
  });
});

describe("containerRows", () => {
  function to(target: string, containment: Containment): ContainmentOutcome {
    return {
      branch: "refs/heads/feature",
      target,
      branchTip: "f1",
      targetTip: "x",
      containment,
      elapsedMs: 1,
    };
  }

  it("中身がまるごと入っているものを上に並べ、同じ種類の中は来た順のまま", () => {
    const rows = containerRows(
      [
        to("refs/heads/b-partial", { kind: "partial", upto: 1, total: 2, squash: null }),
        to("refs/heads/a-merged", { kind: "ancestor" }),
        to("refs/heads/z-contained", { kind: "contained", squash: "sq" }),
        to("refs/heads/y-changed", { kind: "squashedThenChanged", squash: "sq2" }),
        to("refs/heads/c-contained", { kind: "contained", squash: null }),
      ],
      refs,
    );
    expect(rows.map((row) => row.view.mark)).toEqual([
      "contained",
      "contained",
      "changed",
      "merged",
      "partial",
    ]);
    // 同じ種類の中は Rust の並びのまま（名前で並べ直さない）。
    expect(rows[0].target).toBe("refs/heads/z-contained");
    expect(rows[1].target).toBe("refs/heads/c-contained");
  });

  it("飛べる squash と表示名を添える", () => {
    const [row] = containerRows([to(MAIN, { kind: "contained", squash: "sq" })], refs);
    expect(row).toMatchObject({ target: MAIN, label: "origin/main", squash: "sq" });
  });

  it("入っていないものが混じっても行にしない", () => {
    expect(containerRows([to(MAIN, { kind: "notContained" })], refs)).toEqual([]);
  });
});
