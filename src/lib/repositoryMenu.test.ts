import { describe, expect, it } from "vitest";

import type { RepositoryEntry, RepositoryProbe } from "./ipc";
import { canFetch, canReveal } from "./repositoryMenu";

function probe(overrides: Partial<RepositoryProbe> = {}): RepositoryProbe {
  return {
    isRepository: true,
    gitDir: "C:/repo/.git",
    workTree: "C:/repo",
    isBare: false,
    isShallow: false,
    head: null,
    remotes: ["origin"],
    lastFetchAtMs: null,
    indexLockPresent: false,
    error: null,
    ...overrides,
  };
}

function entry(overrides: Partial<RepositoryEntry> = {}): RepositoryEntry {
  return {
    id: "r1",
    name: "repo",
    path: "C:/repo",
    order: 0,
    visibleRefs: { mode: "all", excluded: [] },
    defaultLlmProfileId: null,
    repoSkills: { trusted: false, hashes: {} },
    probe: probe(),
    fetchStale: false,
    ...overrides,
  };
}

describe("canReveal", () => {
  it("フォルダがあれば押せる", () => {
    expect(canReveal([entry()], "r1")).toEqual({ enabled: true, reason: null });
  });

  // **消さずに理由を出す**（CLAUDE.md §6）。probe が null = 移動・削除された。
  it("フォルダが無いときは押せないが、理由と直し方が出る", () => {
    const result = canReveal([entry({ probe: null })], "r1");
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain("再指定");
  });

  it("登録そのものが無いときは、フォルダの話にしない", () => {
    const result = canReveal([entry()], "いない");
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain("登録");
  });

  // 一覧が空でも落ちない（起動直後に右クリックが残っている場合）。
  it("一覧が空でも落ちない", () => {
    expect(canReveal([], "r1").enabled).toBe(false);
  });
});

describe("canFetch", () => {
  it("リモートがあれば押せる", () => {
    expect(canFetch([entry()], "r1", false)).toEqual({ enabled: true, reason: null });
  });

  // **リモートが無いのと、ほかが動いているのを言い分ける。**
  // 同じ「押せない」でも、待てばよいのか永久に押せないのかが違う。
  it("リモートが無いときは取得先が無いと言う", () => {
    const result = canFetch([entry({ probe: probe({ remotes: [] }) })], "r1", false);
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain("リモート");
  });

  it("ほかの処理が動いているときは、そう言う", () => {
    const result = canFetch([entry()], "r1", true);
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain("ほかの処理");
  });

  // 理由が重なったら、先に直すものを出す（reviewPlan と同じ考え方）。
  it("登録が無いことは、ほかの処理より先に出る", () => {
    expect(canFetch([], "r1", true).reason).toContain("登録");
  });

  it("probe が取れていないリポジトリは fetch できない", () => {
    expect(canFetch([entry({ probe: null })], "r1", false).enabled).toBe(false);
  });
});
