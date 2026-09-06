/**
 * AI レビューの実行とイベントの受け取り（T-23）。
 *
 * **判定をここに書かない。** 出し分け・整形は `src/lib/reviewPlan.ts` /
 * `reviewFindings.ts` / `reviewMarkdown.ts` の純関数に置く（CLAUDE.md §8）。
 * フックに書いた条件にはテストが 1 つも当たらない。
 *
 * ここがやるのは 4 つだけ。
 *
 * - 計画を取り直す
 * - 走らせて、`review-progress` を受けて状態へ畳む
 * - 中止する
 * - 履歴を読む
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelReview,
  listReviews,
  loadReview,
  onReviewProgress,
  planReview,
  startReview,
  type DiffSource,
  type ReviewFileResult,
  type ReviewIndexRow,
  type ReviewPlan,
  type ReviewProgress,
  type ReviewText,
  type StoredReview,
} from "../lib/ipc";

/** ドロワーに出しているもの。 */
export type ReviewView = "preflight" | "running" | "result" | "history";

/** 実行中のファイル 1 件。**流れてきた本文をそのまま持つ。** */
export type FileProgress = {
  path: string;
  status: "waiting" | "running" | "done" | "failed";
  /** 流れてきた本文。**構造化する前のまま。** */
  streamed: string;
  result: ReviewFileResult | null;
};

export type ReviewState = {
  view: ReviewView;
  plan: ReviewPlan | null;
  planError: string | null;
  loadingPlan: boolean;
  /** 走っている間だけ埋まる。 */
  progress: FileProgress[];
  summaryStreamed: string;
  summary: ReviewText | null;
  running: boolean;
  cancelling: boolean;
  /** 走り終えた（または履歴から開いた）結果。 */
  stored: StoredReview | null;
  runError: string | null;
  history: ReviewIndexRow[];
  historyError: string | null;
};

const EMPTY: ReviewState = {
  view: "preflight",
  plan: null,
  planError: null,
  loadingPlan: false,
  progress: [],
  summaryStreamed: "",
  summary: null,
  running: false,
  cancelling: false,
  stored: null,
  runError: null,
  history: [],
  historyError: null,
};

function message(error: unknown): string {
  return typeof error === "string" ? error : String(error);
}

export function useReview(repositoryId: string | null) {
  const [state, setState] = useState<ReviewState>(EMPTY);

  /**
   * いま受け付けている走りの ID。
   *
   * **中止してすぐ次を始めると、前の走りの残りが後から届く。** ID が違う
   * イベントは捨てる（`ref` なのは、購読を張り直さずに見比べるため）。
   */
  const currentRun = useRef<string | null>(null);
  /** 通し番号 → パス。**`ReviewPlan.files` の添字ではない**ので自分で覚える。 */
  const paths = useRef<Map<number, string>>(new Map());

  // リポジトリが変わったら全部捨てる。前のリポジトリの結果を出したままにしない。
  useEffect(() => {
    currentRun.current = null;
    paths.current = new Map();
    setState(EMPTY);
  }, [repositoryId]);

  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      const unlisten = await onReviewProgress((event) => {
        if (event.runId !== currentRun.current) return;
        setState((current) => reduce(current, event, paths.current));
      });
      if (cancelled) unlisten();
      else stop = unlisten;
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const refreshPlan = useCallback(
    async (source: DiffSource, profileId: string) => {
      if (repositoryId === null) return;
      setState((current) => ({ ...current, loadingPlan: true, planError: null }));
      try {
        const plan = await planReview({ repositoryId, source, profileId });
        setState((current) => ({ ...current, plan, loadingPlan: false }));
      } catch (error) {
        setState((current) => ({
          ...current,
          plan: null,
          loadingPlan: false,
          // `LlmError` も文字列も来る。**どちらでも読める形にして渡す。**
          planError: readError(error),
        }));
      }
    },
    [repositoryId],
  );

  const refreshHistory = useCallback(async () => {
    if (repositoryId === null) return;
    try {
      const history = await listReviews(repositoryId);
      setState((current) => ({ ...current, history, historyError: null }));
    } catch (error) {
      setState((current) => ({ ...current, history: [], historyError: message(error) }));
    }
  }, [repositoryId]);

  const run = useCallback(
    async (source: DiffSource, profileId: string, selected: string[]) => {
      if (repositoryId === null) return;
      const runId = crypto.randomUUID();
      currentRun.current = runId;
      paths.current = new Map();

      setState((current) => ({
        ...current,
        view: "running",
        running: true,
        cancelling: false,
        runError: null,
        stored: null,
        summary: null,
        summaryStreamed: "",
        // 選んだ順に並べておく。**始まる前から一覧が見える**ほうが読める。
        progress: selected.map((path) => ({
          path,
          status: "waiting",
          streamed: "",
          result: null,
        })),
      }));

      try {
        const stored = await startReview({
          runId,
          repositoryId,
          source,
          profileId,
          paths: selected,
        });
        // 中止して次を始めていたら、遅れて返ってきた結果は捨てる。
        if (currentRun.current !== runId) return;
        setState((current) => ({
          ...current,
          view: "result",
          running: false,
          cancelling: false,
          stored,
        }));
        void refreshHistory();
      } catch (error) {
        if (currentRun.current !== runId) return;
        setState((current) => ({
          ...current,
          view: "result",
          running: false,
          cancelling: false,
          runError: readError(error),
        }));
      }
    },
    [repositoryId, refreshHistory],
  );

  const cancel = useCallback(async () => {
    // **押した瞬間に画面を進める。** 実際に畳まれるのは次のチャンク。
    setState((current) => ({ ...current, cancelling: true }));
    await cancelReview();
  }, []);

  /**
   * 履歴の 1 件を開く。**開けた 1 件を返す。**
   *
   * 返すのは、呼び出し側が**当時の差分に画面を合わせる**ため（T-23 の受け入れ条件）。
   * 合わせ先を決めるのは純関数（`lib/reviewTarget.ts` の `selectionForSource`）で、
   * ここは読むだけ。
   */
  const openHistoryEntry = useCallback(
    async (file: string): Promise<StoredReview | null> => {
      if (repositoryId === null) return null;
      try {
        const stored = await loadReview(repositoryId, file);
        setState((current) => ({ ...current, view: "result", stored, runError: null }));
        return stored;
      } catch (error) {
        setState((current) => ({ ...current, historyError: message(error) }));
        return null;
      }
    },
    [repositoryId],
  );

  const show = useCallback((view: ReviewView) => {
    setState((current) => ({ ...current, view }));
  }, []);

  return { state, refreshPlan, refreshHistory, run, cancel, openHistoryEntry, show };
}

/** `LlmError` は `message` を持つ。文字列で来ることもある。 */
function readError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** イベント 1 つを状態へ畳む。**純粋**（テストしやすさのため外に出してある）。 */
export function reduce(
  current: ReviewState,
  event: ReviewProgress,
  paths: Map<number, string>,
): ReviewState {
  switch (event.kind) {
    case "started":
      return current;

    case "fileStarted": {
      paths.set(event.index, event.path);
      return {
        ...current,
        progress: current.progress.map((file) =>
          file.path === event.path ? { ...file, status: "running" } : file,
        ),
      };
    }

    case "delta": {
      const path = paths.get(event.index);
      if (path === undefined) return current;
      return {
        ...current,
        progress: current.progress.map((file) =>
          file.path === path ? { ...file, streamed: file.streamed + event.text } : file,
        ),
      };
    }

    case "fileDone": {
      const path = paths.get(event.index) ?? event.result.path;
      return {
        ...current,
        progress: current.progress.map((file) =>
          file.path === path
            ? {
                ...file,
                status: event.result.error === null ? "done" : "failed",
                result: event.result,
              }
            : file,
        ),
      };
    }

    case "summaryStarted":
      return { ...current, summaryStreamed: "" };

    case "summaryDelta":
      return { ...current, summaryStreamed: current.summaryStreamed + event.text };

    case "summaryDone":
      return { ...current, summary: event.summary };
  }
}
