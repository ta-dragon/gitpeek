import { describe, expect, it } from "vitest";

import type { RefEntry } from "./ipc";
import { checkoutChoices, checkoutCommit, localBranchName, mergeVerdict } from "./writeOps";

function ref(name: string, kind: RefEntry["kind"], shortName: string): RefEntry {
  return {
    name,
    shortName,
    kind,
    target: "0".repeat(40),
    upstream: null,
    outOfGraph: false,
    orphan: false,
  };
}

const local = ref("refs/heads/main", "localBranch", "main");
const remote = ref("refs/remotes/origin/feature", "remoteBranch", "origin/feature");
const tag = ref("refs/tags/v1.0", "tag", "v1.0");

describe("ローカルブランチ名の取り出し", () => {
  it("リモート名を 1 段だけ剥がす", () => {
    expect(localBranchName("refs/remotes/origin/feature")).toBe("feature");
  });

  /** **最後の `/` で切ってはいけない。** ブランチ名にはスラッシュが入る。 */
  it("ブランチ名のスラッシュを残す", () => {
    expect(localBranchName("refs/remotes/origin/feature/login")).toBe("feature/login");
  });

  it("リモート名が origin でなくてもよい", () => {
    expect(localBranchName("refs/remotes/upstream/main")).toBe("main");
  });
});

describe("checkout の選択肢", () => {
  /** **短い名前で渡す。** 完全な ref 名だと git はブランチとして扱わず detached になる。 */
  it("ローカルブランチは短い名前で切り替えるだけ", () => {
    const choices = checkoutChoices(local, [local]);
    expect(choices).toHaveLength(1);
    expect(choices[0].target).toEqual({ kind: "branch", name: "main" });
  });

  /** **完全な ref 名で渡す。** 短い名前だと DWIM がローカルブランチを勝手に作る。 */
  it("タグは detached で開くだけ", () => {
    const choices = checkoutChoices(tag, [local, tag]);
    expect(choices).toHaveLength(1);
    expect(choices[0].target).toEqual({ kind: "detach", rev: "refs/tags/v1.0" });
    expect(choices[0].primary).toBe(true);
  });

  it("リモート追跡ブランチは「作る」と「detached」の 2 択", () => {
    const choices = checkoutChoices(remote, [local, remote]);
    expect(choices.map((choice) => choice.kind)).toEqual(["track", "detach"]);
    expect(choices[0].target).toEqual({
      kind: "track",
      remoteRef: "refs/remotes/origin/feature",
      branch: "feature",
    });
    expect(choices[1].target).toEqual({ kind: "detach", rev: "refs/remotes/origin/feature" });
  });

  /** **`checkout -b` は既存の名前では失敗する。** 作らずに切り替える側を出す。 */
  it("同じ名前のローカルブランチがあれば作らない", () => {
    const existing = ref("refs/heads/feature", "localBranch", "feature");
    const choices = checkoutChoices(remote, [local, existing, remote]);

    expect(choices.map((choice) => choice.kind)).toEqual(["switch", "detach"]);
    expect(choices[0].target).toEqual({ kind: "branch", name: "feature" });
  });

  /** 名前が似ているだけのブランチを取り違えない。 */
  it("前方一致では既存と見なさない", () => {
    const other = ref("refs/heads/feature-2", "localBranch", "feature-2");
    const choices = checkoutChoices(remote, [other, remote]);
    expect(choices[0].kind).toBe("track");
  });

  it("既定の選択肢はどの場合もちょうど 1 つ", () => {
    for (const entry of [local, remote, tag]) {
      const primary = checkoutChoices(entry, [local, remote, tag]).filter(
        (choice) => choice.primary,
      );
      expect(primary).toHaveLength(1);
    }
  });

  it("コミットは detached", () => {
    expect(checkoutCommit("abc123")).toEqual({ kind: "detach", rev: "abc123" });
  });
});

describe("FF マージの可否", () => {
  it("遅れているだけなら取り込める", () => {
    expect(mergeVerdict({ ahead: 0, behind: 3, known: true }, false)).toEqual({
      can: true,
      behind: 3,
    });
  });

  /** **1 件でも進んでいたら fast-forward にならない**（CLAUDE.md §1）。 */
  it("進んでいたら取り込まない", () => {
    expect(mergeVerdict({ ahead: 1, behind: 3, known: true }, false)).toEqual({
      can: false,
      why: "ahead",
    });
  });

  it("同じなら取り込むものが無い", () => {
    expect(mergeVerdict({ ahead: 0, behind: 0, known: true }, false)).toEqual({
      can: false,
      why: "upToDate",
    });
  });

  /** detached には取り込む先のブランチが無い（DESIGN.md §8.2）。 */
  it("detached では出さない", () => {
    expect(mergeVerdict({ ahead: 0, behind: 3, known: true }, true)).toEqual({
      can: false,
      why: "detached",
    });
  });

  /** 読み込んだコミットの外は判定できない。**「できる」と言わない。** */
  it("判定できないときは取り込まない", () => {
    expect(mergeVerdict({ ahead: 0, behind: 0, known: false }, false)).toEqual({
      can: false,
      why: "unknown",
    });
  });
});
