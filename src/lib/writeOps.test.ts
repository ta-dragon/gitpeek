import { describe, expect, it } from "vitest";

import type { FetchMergeOutcome, FetchOutcome, MergeCheck, RefEntry } from "./ipc";
import {
  checkoutChoices,
  checkoutCommit,
  fetchMergeDetails,
  fetchMergeStage,
  localBranchName,
  mergeVerdict,
} from "./writeOps";

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

/**
 * 取ってきて取り込む（T-31。docs/DESIGN.md §8.6）。
 *
 * **Rust が返す形をそのまま組み立てる。** ここで「ありそうな形」に寄せると、
 * 実際に届く形（走らなかった段が null）と食い違ったまま緑になる（申し送り 2）。
 */
describe("取ってきて取り込んだ結果の畳み方", () => {
  const fetched = (status: FetchOutcome["status"]): FetchOutcome => ({
    status,
    message: "fetch しました。",
    lines: ["From /tmp/origin"],
    durationMs: 12,
  });

  const check = (over: Partial<MergeCheck> = {}): MergeCheck => ({
    ahead: 0,
    behind: 1,
    known: true,
    detached: false,
    ...over,
  });

  const outcome = (over: Partial<FetchMergeOutcome> = {}): FetchMergeOutcome => ({
    fetch: null,
    check: null,
    merge: null,
    refused: null,
    ...over,
  });

  it("判定で止めたときは、fetch も走っていない", () => {
    const stage = fetchMergeStage(
      outcome({ refused: { blockers: ["dirty"], untracked: 0, changed: 2 } }),
    );
    expect(stage).toEqual({ stage: "refused" });
  });

  /** **fetch が失敗したのを「取り込むものがありません」と言わない。** */
  it("取ってくるところで失敗したら、そこで止まったと言う", () => {
    expect(fetchMergeStage(outcome({ fetch: fetched("failed") }))).toEqual({
      stage: "fetchStopped",
      status: "failed",
    });
  });

  it("中止も、取ってくるところで止まった扱い", () => {
    expect(fetchMergeStage(outcome({ fetch: fetched("cancelled") }))).toEqual({
      stage: "fetchStopped",
      status: "cancelled",
    });
  });

  /** タグが弾かれただけなら取り込みへ進む（Rust 側の決め。DESIGN.md §8.6）。 */
  it("一部だけ取り込めたときも、取り込みの結果を見る", () => {
    const stage = fetchMergeStage(
      outcome({
        fetch: fetched("partial"),
        check: check(),
        merge: { ok: true, message: "取り込みました。", details: [], refused: null },
      }),
    );
    expect(stage).toEqual({ stage: "merged", ok: true });
  });

  it("取り込みが失敗したら、取り込んだ段で失敗したと言う", () => {
    const stage = fetchMergeStage(
      outcome({
        fetch: fetched("success"),
        check: check(),
        merge: { ok: false, message: "だめ", details: [], refused: null },
      }),
    );
    expect(stage).toEqual({ stage: "merged", ok: false });
  });

  /** 取り込まなかった理由は `mergeVerdict` と同じ語を返す（言い方を 2 つ持たない）。 */
  it("取り込まなかった理由を、確認画面と同じ語で返す", () => {
    const cases: Array<[Partial<MergeCheck>, string]> = [
      [{ ahead: 2, behind: 3 }, "ahead"],
      [{ ahead: 0, behind: 0 }, "upToDate"],
      [{ known: false }, "unknown"],
      [{ detached: true }, "detached"],
    ];
    for (const [over, why] of cases) {
      const stage = fetchMergeStage(
        outcome({ fetch: fetched("success"), check: check(over) }),
      );
      expect(stage).toEqual({ stage: "notMerged", why });
    }
  });

  /** **判定が落ちていても握り潰さない。** 形が変わったら「判定できない」に寄せる。 */
  it("判定が入っていなければ、判定できないとして扱う", () => {
    expect(fetchMergeStage(outcome({ fetch: fetched("success") }))).toEqual({
      stage: "notMerged",
      why: "unknown",
    });
  });

  it("生の行は fetch の分も取り込みの分も落とさない", () => {
    const lines = fetchMergeDetails(
      outcome({
        fetch: fetched("success"),
        check: check(),
        merge: { ok: true, message: "", details: ["Updating a..b"], refused: null },
      }),
    );
    expect(lines).toEqual(["From /tmp/origin", "Updating a..b"]);
  });
});
