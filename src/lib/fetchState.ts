/**
 * 一括 fetch の進行状態（純関数。docs/DESIGN.md §8.3）。
 *
 * **1 件ずつ順に実行する。** 並列にすると認証ウィンドウが同時に何枚も開く。
 * ここが持つのは「どこまで進んだか」と「何が成功したか」だけで、実行そのものは
 * `useFetch` が回す。
 *
 * **中止は「次のリポジトリへ進まない」という意味。** 実行中の 1 件は Rust 側で落とす。
 * 落とした 1 件も、そこまでに取り込んだ ref は残る。
 */
import type { FetchOutcome, FetchStatus } from "./ipc";

export type FetchTarget = { id: string; name: string };

export type FetchResult = FetchTarget & FetchOutcome;

export type FetchRun = {
  /** 実行する順。**この順のまま 1 件ずつ進む。** */
  targets: FetchTarget[];
  /** 次に実行する添字。`targets.length` に達したら終わり。 */
  index: number;
  /** 終わったぶんの結果。`targets` と同じ順に積む。 */
  results: FetchResult[];
  /** 中止を頼まれたか。**進行中の 1 件は結果として積まれる。** */
  cancelled: boolean;
};

export function startRun(targets: FetchTarget[]): FetchRun {
  return { targets, index: 0, results: [], cancelled: false };
}

/** いま実行しているリポジトリ。終わっていれば null。 */
export function currentTarget(run: FetchRun): FetchTarget | null {
  return run.targets[run.index] ?? null;
}

/** 1 件ぶんの結果を積んで次へ進める。 */
export function recordResult(run: FetchRun, outcome: FetchOutcome): FetchRun {
  const target = currentTarget(run);
  if (target === null) return run;
  return {
    ...run,
    index: run.index + 1,
    results: [...run.results, { ...target, ...outcome }],
  };
}

/** 中止を頼む。**いま走っている 1 件は Rust 側が落とす**ので、ここでは印だけ付ける。 */
export function requestCancel(run: FetchRun): FetchRun {
  return { ...run, cancelled: true };
}

/**
 * まだ実行するものが残っているか。
 *
 * **中止されていたら残っていても進まない。** ここを見ずに `index` だけで回すと、
 * 中止しても最後まで走り切る。
 */
export function hasMore(run: FetchRun): boolean {
  return !run.cancelled && run.index < run.targets.length;
}

/** 全部終わったか（中止で打ち切った場合も含む）。 */
export function isDone(run: FetchRun): boolean {
  return run.cancelled || run.index >= run.targets.length;
}

export type FetchSummary = {
  success: number;
  /** 一部だけ取り込めた（タグの衝突）。**成功にも失敗にも混ぜない。** */
  partial: number;
  failed: number;
  cancelled: number;
  /** 中止で一度も実行されなかったぶん。**「成功でも失敗でもない」を潰さない。** */
  skipped: number;
  total: number;
};

export function summarize(run: FetchRun): FetchSummary {
  const count = (status: FetchStatus) =>
    run.results.filter((result) => result.status === status).length;

  return {
    success: count("success"),
    partial: count("partial"),
    failed: count("failed"),
    cancelled: count("cancelled"),
    skipped: run.targets.length - run.results.length,
    total: run.targets.length,
  };
}
