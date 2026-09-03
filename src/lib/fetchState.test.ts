import { describe, expect, it } from "vitest";

import {
  currentTarget,
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
    state = recordResult(state, outcome("success"));

    expect(summarize(state)).toEqual({
      success: 2,
      failed: 1,
      cancelled: 0,
      skipped: 0,
      total: 3,
    });
  });
});
