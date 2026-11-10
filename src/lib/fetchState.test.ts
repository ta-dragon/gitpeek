import { describe, expect, it } from "vitest";

import {
  currentTarget,
  fetchButton,
  hasMore,
  isDone,
  recordResult,
  requestCancel,
  startRun,
  summarize,
  type FetchRun,
} from "./fetchState";
import type { FetchOutcome, FetchStatus } from "./ipc";

function outcome(status: FetchStatus): FetchOutcome {
  return { status, message: "", lines: [], durationMs: 1 };
}

function run(): FetchRun {
  return startRun([
    { id: "a", name: "alpha" },
    { id: "b", name: "bravo" },
    { id: "c", name: "charlie" },
  ]);
}

describe("順に 1 件ずつ進む", () => {
  it("先頭から順に実行する", () => {
    let state = run();
    expect(currentTarget(state)?.id).toBe("a");

    state = recordResult(state, outcome("success"));
    expect(currentTarget(state)?.id).toBe("b");

    state = recordResult(state, outcome("failed"));
    expect(currentTarget(state)?.id).toBe("c");
  });

  it("結果は実行した順に積む", () => {
    let state = run();
    state = recordResult(state, outcome("success"));
    state = recordResult(state, outcome("failed"));

    expect(state.results.map((result) => result.id)).toEqual(["a", "b"]);
    expect(state.results.map((result) => result.status)).toEqual(["success", "failed"]);
  });

  it("全部終われば次は無い", () => {
    let state = startRun([{ id: "a", name: "alpha" }]);
    state = recordResult(state, outcome("success"));

    expect(currentTarget(state)).toBeNull();
    expect(hasMore(state)).toBe(false);
    expect(isDone(state)).toBe(true);
    // 終わったあとに積んでも壊れない。
    expect(recordResult(state, outcome("success"))).toBe(state);
  });

  it("対象が空なら最初から終わっている", () => {
    const state = startRun([]);
    expect(hasMore(state)).toBe(false);
    expect(isDone(state)).toBe(true);
  });
});

describe("中止", () => {
  /** **`index` だけで回すと、中止しても最後まで走り切る。** */
  it("残っていても進まない", () => {
    let state = run();
    state = recordResult(state, outcome("success"));
    state = requestCancel(state);

    expect(state.index).toBe(1);
    expect(hasMore(state)).toBe(false);
    expect(isDone(state)).toBe(true);
  });

  /** 一度も実行されなかったぶんを「失敗」に混ぜない。 */
  it("実行しなかったぶんを skipped として数える", () => {
    let state = run();
    state = recordResult(state, outcome("success"));
    state = recordResult(state, outcome("cancelled"));
    state = requestCancel(state);

    expect(summarize(state)).toEqual({
      success: 1,
      partial: 0,
      failed: 0,
      cancelled: 1,
      skipped: 1,
      total: 3,
    });
  });
});

describe("summarize", () => {
  it("状態ごとに数える", () => {
    let state = run();
    state = recordResult(state, outcome("failed"));
    state = recordResult(state, outcome("success"));
    state = recordResult(state, outcome("partial"));

    expect(summarize(state)).toEqual({
      success: 1,
      partial: 1,
      failed: 1,
      cancelled: 0,
      skipped: 0,
      total: 3,
    });
  });

  /** **一部成功を成功にも失敗にも混ぜない。** 混ぜると何が起きたか分からなくなる。 */
  it("一部成功を独立して数える", () => {
    let state = startRun([{ id: "a", name: "alpha" }]);
    state = recordResult(state, outcome("partial"));

    const summary = summarize(state);
    expect(summary.partial).toBe(1);
    expect(summary.success).toBe(0);
    expect(summary.failed).toBe(0);
  });
});

describe("fetchButton", () => {
  it("取ってきている間は中止", () => {
    expect(fetchButton(run(), "fetching")).toEqual({ kind: "cancel" });
  });

  it("中止を押したあと、走っている 1 件が終わるまでは閉じられない", () => {
    // `isDone` は中止を押した時点で true になるが、まだ git が走っている。
    const cancelled = requestCancel(run());
    expect(isDone(cancelled)).toBe(true);

    expect(fetchButton(cancelled, "fetching")).toEqual({ kind: "cancelling" });
  });

  it("取り終えても、読み直している間は閉じられない", () => {
    // ここで閉じると、読み直しが終わったところで結果の画面がまた出た。
    let finished = run();
    while (hasMore(finished)) finished = recordResult(finished, outcome("success"));

    expect(fetchButton(finished, "refreshing")).toEqual({ kind: "refreshing" });
  });

  it("全部終わったら閉じられる", () => {
    expect(fetchButton(requestCancel(run()), "done")).toEqual({ kind: "close" });
  });
});
