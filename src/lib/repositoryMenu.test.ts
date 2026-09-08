import { describe, expect, it } from "vitest";

import type { RepositoryEntry, RepositoryProbe } from "./ipc";
import { canFetch, canFetchMerge, canReveal } from "./repositoryMenu";

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

/**
 * 取ってきて取り込む（T-31。docs/DESIGN.md §8.6）。
 *
 * **見るのは「取ってきても変わらないこと」だけ。** ahead / behind をここで見ると、
 * いま分岐しているだけの場面で押せなくなる（取ってくれば解けることがある）。
 */
describe("canFetchMerge", () => {
  it("リモート追跡ブランチなら押せる", () => {
    expect(canFetchMerge("remoteBranch", "main")).toEqual({ enabled: true, why: null });
  });

  it("detached では取り込む先が無い", () => {
    expect(canFetchMerge("remoteBranch", null)).toEqual({ enabled: false, why: "detached" });
  });

  /** 手元にしかないブランチは、取ってきても指す先が動かない。 */
  it("ローカルブランチには取ってくる先が無い", () => {
    expect(canFetchMerge("localBranch", "main")).toEqual({
      enabled: false,
      why: "localBranch",
    });
  });

  /** タグはそもそもメニューに出さないが、渡されても押せないこと。 */
  it("タグは押せない", () => {
    expect(canFetchMerge("tag", "main").enabled).toBe(false);
  });

  /**
   * **detached の判定を先に出す。** 逆にすると、detached で
   * ローカルブランチを右クリックしたときに「取ってくる先が無い」とだけ出て、
   * ブランチへ切り替えれば済む話だと読めない。
   */
  it("detached とローカルブランチが重なったら detached を言う", () => {
    expect(canFetchMerge("localBranch", null).why).toBe("detached");
  });
});
