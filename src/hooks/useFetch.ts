/**
 * fetch の実行と進捗（docs/DESIGN.md §8.3）。
 *
 * **定期実行はしない。** ここを呼ぶのは利用者の操作だけで、タイマーからは呼ばない。
 * 自動 fetch は、認証キャッシュが切れているリモートに当たった瞬間、
 * 何もしていないのに認証ウィンドウを前面に出す。
 *
 * **1 件ずつ順に回す。** 並列にすると認証ウィンドウが同時に何枚も開く。
 * 進行の管理は純関数（`lib/fetchState.ts`）に置いてあり、ここは実行と配線だけ。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  currentTarget,
  hasMore,
  recordResult,
  requestCancel,
  startRun,
  type FetchPhase,
  type FetchRun,
  type FetchTarget,
} from "../lib/fetchState";
import { cancelFetch, fetchRepository, onFetchProgress, type FetchProgress } from "../lib/ipc";
import * as repositories from "../store/repositories";
import * as snapshots from "../store/snapshot";

export type FetchState = {
  run: FetchRun | null;
  /** いま走っている 1 件の中の進捗。段階が変わるまでは null。 */
  progress: FetchProgress | null;
  /** 実行前の確認待ち。**一括のときだけ出す**（1 件には確認を出さない）。 */
  pending: FetchTarget[] | null;
  /** 取ってきている / 読み直している / 終わった。**閉じられるのは終わってから**（`fetchButton`）。 */
  phase: FetchPhase;
};

export function useFetch() {
  const [state, setState] = useState<FetchState>({
    run: null,
    progress: null,
    pending: null,
    phase: "done",
  });

  // 中止したかどうかは実行ループの中から読む。state の値は閉じ込められて古くなる。
  const cancelled = useRef(false);
  // **走っている間は次を始めない。** `Ctrl+R` を連打すると同じリポジトリに
  // git を 2 つ当てることになり、`index.lock` の取り合いになる。
  const running = useRef(false);

  useEffect(() => {
    const unlisten = onFetchProgress((progress) => {
      setState((current) => (current.run === null ? current : { ...current, progress }));
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  /** 1 件ずつ順に回す。**中止されたら次へ進まない。** */
  const drive = useCallback(async (targets: FetchTarget[]) => {
    if (running.current) return;
    running.current = true;
    cancelled.current = false;

    let run = startRun(targets);
    setState({ run, progress: null, pending: null, phase: "fetching" });

    try {
      while (hasMore(run)) {
        const target = currentTarget(run);
        if (target === null) break;

        try {
          const outcome = await fetchRepository(target.id);
          run = recordResult(run, outcome);
        } catch (error) {
          // 呼び出し自体が失敗した（フォルダが消えている等）。**残りは止めない。**
          run = recordResult(run, {
            status: "failed",
            message: messageOf(error),
            lines: [],
            durationMs: 0,
          });
        }

        if (cancelled.current) run = requestCancel(run);
        setState((current) => ({ ...current, run, progress: null }));
      }

      // **読み直しが終わるまで閉じさせない。** 途中で閉じると、下の `finally` が結果を
      // 入れ直して、閉じたはずの画面がまた出る（2026-11-11 に利用者が見つけた）。
      setState((current) => ({ ...current, run, progress: null, phase: "refreshing" }));

      // ref が動いた可能性があるので、一覧（放置警告と ahead/behind の素）を取り直す。
      // 開いているリポジトリだけ履歴を読み直す（docs/DESIGN.md §8.5）。
      // 開いていないものは、切り替えたときに読めばよい。
      const open = snapshots.currentRepositoryId();
      const touched = run.results.some(
        (result) => result.id === open && result.status !== "failed",
      );
      // **2 つは同時に走らせる。** 一覧の取り直しは登録した全リポジトリに git を当てるので遅く、
      // 終わるのを待ってからグラフを読み直すと、そのぶん閉じられない時間が延びる。
      // グラフの読み込み（`store/snapshot.ts`）は一覧のストアを読まないので、順番は要らない。
      await Promise.all([repositories.refresh(), touched ? snapshots.reload() : undefined]);
    } finally {
      // **必ず外す。** 読み直しで例外が出たまま立てっぱなしにすると、
      // このセッションでは二度と fetch できなくなる。
      running.current = false;
      // **閉じられていたら入れ直さない**（閉じた結果を生き返らせない）。
      setState((current) =>
        current.run === null ? current : { ...current, run, progress: null, phase: "done" },
      );
    }
  }, []);

  /** 1 件だけ。**確認は出さない**（対象がひとつなら意図は明らか）。 */
  const fetchOne = useCallback(
    (target: FetchTarget) => {
      void drive([target]);
    },
    [drive],
  );

  /** 一括。**実行前に確認を 1 回**（docs/DESIGN.md §8.3）。 */
  const askAll = useCallback((targets: FetchTarget[]) => {
    if (targets.length === 0) return;
    setState({ run: null, progress: null, pending: targets, phase: "done" });
  }, []);

  /** 確認に「はい」。**対象は呼び出し側から渡す** — 更新関数の中で走らせない
   *  （StrictMode で更新関数が 2 回呼ばれ、fetch が二重に走る）。 */
  const confirmAll = useCallback(
    (targets: FetchTarget[]) => {
      void drive(targets);
    },
    [drive],
  );

  const dismiss = useCallback(() => {
    setState({ run: null, progress: null, pending: null, phase: "done" });
  }, []);

  /** 中止。**走っている 1 件は Rust 側が落とす**が、取り込み済みの ref は戻らない。 */
  const cancel = useCallback(() => {
    cancelled.current = true;
    setState((current) =>
      current.run === null ? current : { ...current, run: requestCancel(current.run) },
    );
    void cancelFetch();
  }, []);

  return { ...state, fetchOne, askAll, confirmAll, dismiss, cancel };
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : String(error);
}
