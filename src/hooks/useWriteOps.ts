/**
 * checkout と FF マージの配線（T-18。docs/DESIGN.md §8.1, §8.2, §8.5）。
 *
 * 流れは **判定 → 確認 → 実行 → 読み直し** の 1 本だけ。起動点が 4 つある
 * （ref ツリーの右クリック / ダブルクリック / グラフ行の右クリック / 上流の取り込み）ので、
 * どこから来ても同じ経路を通す。
 *
 * **判定は Rust 側の `git::ops::preflight` の 1 箇所だけ。** ここでは呼ぶだけで、
 * 条件を組み直さない。実行の直前に Rust 側がもう一度通し、通らなければ走らせずに
 * `refused` を返す（確認してから押すまでの間に状態は変わりうる）。
 *
 * **確認の中身は `request` が全部持つ。** 対象を別の state に置くと、
 * ダイアログと実行対象がずれる。
 */
import { useCallback, useState } from "react";

import {
  checkout as runCheckout,
  mergeCheck,
  mergeFf,
  preflightWrite,
  type CheckoutTarget,
  type MergeCheck,
  type WriteGuard,
  type WriteOutcome,
} from "../lib/ipc";
import type { CheckoutChoice } from "../lib/writeOps";
import * as repositories from "../store/repositories";
import * as snapshots from "../store/snapshot";

/** 何を checkout しようとしているか。**文面を決めるのはこれ。** */
export type CheckoutSubject = {
  kind: "branch" | "remote" | "tag" | "commit";
  name: string;
};

export type WriteRequest =
  | {
      op: "checkout";
      guard: WriteGuard;
      subject: CheckoutSubject;
      choices: CheckoutChoice[];
    }
  | {
      op: "merge";
      guard: WriteGuard;
      check: MergeCheck;
      /** git へ渡す完全な ref 名。 */
      rev: string;
      /** 画面に出す名前。 */
      revLabel: string;
      /** 取り込む先のブランチ。detached なら null。 */
      branch: string | null;
    };

export type WriteState = {
  /** 確認待ち。null なら何も聞いていない。 */
  request: WriteRequest | null;
  /** 結果。実行が終わるまでは null。 */
  outcome: WriteOutcome | null;
  busy: boolean;
};

export function useWriteOps(repositoryId: string | null) {
  const [state, setState] = useState<WriteState>({
    request: null,
    outcome: null,
    busy: false,
  });

  const askCheckout = useCallback(
    (subject: CheckoutSubject, choices: CheckoutChoice[]) => {
      if (repositoryId === null || choices.length === 0) return;
      void preflightWrite(repositoryId).then((guard) => {
        setState({
          request: { op: "checkout", guard, subject, choices },
          outcome: null,
          busy: false,
        });
      });
    },
    [repositoryId],
  );

  /** FF マージの確認。**取り込めるかも同時に聞く**（手元のグラフから数える）。 */
  const askMerge = useCallback(
    (rev: string, revLabel: string, revSha: string, branch: string | null) => {
      if (repositoryId === null) return;
      void Promise.all([preflightWrite(repositoryId), mergeCheck(repositoryId, revSha)]).then(
        ([guard, check]) => {
          setState({
            request: { op: "merge", guard, check, rev, revLabel, branch },
            outcome: null,
            busy: false,
          });
        },
      );
    },
    [repositoryId],
  );

  /**
   * 実行して読み直す。
   *
   * **全コミットメタ情報を取り直してレーンを計算し直す**（docs/DESIGN.md §8.5）。
   * 部分更新は持ち込まない。一覧も取り直す（HEAD 表示と ahead/behind が変わる）。
   */
  const run = useCallback(async (execute: () => Promise<WriteOutcome>) => {
    setState({ request: null, outcome: null, busy: true });
    try {
      const outcome = await execute();
      setState({ request: null, outcome, busy: false });
      if (outcome.ok) {
        await snapshots.reload();
        await repositories.refresh();
      }
    } catch (error) {
      setState({
        request: null,
        outcome: { ok: false, message: messageOf(error), details: [], refused: null },
        busy: false,
      });
    }
  }, []);

  const doCheckout = useCallback(
    (target: CheckoutTarget) => {
      if (repositoryId === null) return;
      void run(() => runCheckout(repositoryId, target));
    },
    [repositoryId, run],
  );

  const doMerge = useCallback(
    (rev: string) => {
      if (repositoryId === null) return;
      void run(() => mergeFf(repositoryId, rev));
    },
    [repositoryId, run],
  );

  const dismiss = useCallback(() => {
    setState({ request: null, outcome: null, busy: false });
  }, []);

  return { ...state, askCheckout, askMerge, doCheckout, doMerge, dismiss };
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : String(error);
}
