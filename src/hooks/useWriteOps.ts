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
import { useCallback, useEffect, useState } from "react";

import {
  cancelFetch,
  checkout as runCheckout,
  fetchAndMerge,
  mergeCheck,
  mergeFf,
  onFetchMergePhase,
  onFetchProgress,
  preflightWrite,
  type CheckoutTarget,
  type FetchMergeOutcome,
  type FetchProgress,
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
    }
  | {
      /** 取ってきてから取り込む（T-31。docs/DESIGN.md §8.6）。 */
      op: "fetchMerge";
      guard: WriteGuard;
      /** **取ってくる前の**値。取ってくると変わるので、確認画面では注記として出す。 */
      check: MergeCheck;
      rev: string;
      revLabel: string;
      branch: string | null;
    };

/** 「取ってきて取り込む」のいまの段。**中止できるのは `fetching` の間だけ。** */
export type FetchMergePhase = "fetching" | "merging";

export type WriteState = {
  /** 確認待ち。null なら何も聞いていない。 */
  request: WriteRequest | null;
  /** 結果。実行が終わるまでは null。 */
  outcome: WriteOutcome | null;
  /** 「取ってきて取り込む」の結果。**形が違う**ので別に持つ（T-31）。 */
  fetchMerge: FetchMergeOutcome | null;
  /** 「取ってきて取り込む」が走っている段。走っていなければ null。 */
  phase: FetchMergePhase | null;
  /** 取ってくる間の進捗。段が変わるまでは null。 */
  progress: FetchProgress | null;
  /** 中止を押した。**押したことは残す**（効かない中止ボタンを押させない）。 */
  cancelling: boolean;
  busy: boolean;
};

export function useWriteOps(
  repositoryId: string | null,
  /**
   * 書き込みが成功して**読み直しまで終わった**あとに呼ぶ。
   *
   * checkout は HEAD を動かすので、**グラフがそのままだと利用者は自分の居場所を見失う**
   * （古いブランチへ切り替えると、選択行は数百行下のまま）。ここで HEAD へ寄せる。
   * 読み直しより前に呼ぶと、まだ古い HEAD を指している。
   */
  onApplied: () => void,
) {
  const [state, setState] = useState<WriteState>(idle);

  // 取ってくる間の進捗。**走っていないときは捨てる**（一括 fetch の進捗が
  // 同じイベントで流れてくるので、拾いっぱなしにすると閉じた画面が動く）。
  useEffect(() => {
    const unlisten = onFetchProgress((progress) => {
      setState((current) =>
        current.phase === "fetching" ? { ...current, progress } : current,
      );
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  // 取り込みへ移った合図。**ここから中止は効かない**ので、ボタンを閉じる。
  useEffect(() => {
    const unlisten = onFetchMergePhase(() => {
      setState((current) =>
        current.phase === null ? current : { ...current, phase: "merging", progress: null },
      );
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const askCheckout = useCallback(
    (subject: CheckoutSubject, choices: CheckoutChoice[]) => {
      if (repositoryId === null || choices.length === 0) return;
      void preflightWrite(repositoryId).then((guard) => {
        setState({ ...idle(), request: { op: "checkout", guard, subject, choices } });
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
            ...idle(),
            request: { op: "merge", guard, check, rev, revLabel, branch },
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
    setState({ ...idle(), busy: true });
    try {
      const outcome = await execute();
      setState({ ...idle(), outcome });
      if (outcome.ok) {
        await snapshots.reload();
        await repositories.refresh();
        onApplied();
      }
    } catch (error) {
      setState({
        ...idle(),
        outcome: { ok: false, message: messageOf(error), details: [], refused: null },
      });
    }
  }, [onApplied]);

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

  /**
   * 取ってきて取り込む確認（T-31。docs/DESIGN.md §8.6）。
   *
   * **判定は取ってくる前の値**なので、確認画面ではいまの値として出すだけで、
   * 押せるかどうかには使わない（取ってくると変わる）。取り込むかどうかを
   * 決めるのは Rust 側が取ってきたあとに通す判定。
   */
  const askFetchMerge = useCallback(
    (rev: string, revLabel: string, revSha: string, branch: string | null) => {
      if (repositoryId === null) return;
      void Promise.all([preflightWrite(repositoryId), mergeCheck(repositoryId, revSha)]).then(
        ([guard, check]) => {
          setState({
            ...idle(),
            request: { op: "fetchMerge", guard, check, rev, revLabel, branch },
          });
        },
      );
    },
    [repositoryId],
  );

  /**
   * 取ってきて取り込む。**呼ぶコマンドは 1 つだけ。**
   *
   * ここでフロントが fetch と merge を 2 回呼ぶ形にすると、順番と中断の扱いが
   * この `.tsx` 側に入ってテストが 1 つも当たらない（CLAUDE.md §8）。
   */
  const doFetchMerge = useCallback(
    (rev: string) => {
      if (repositoryId === null) return;
      setState({ ...idle(), phase: "fetching", busy: true });

      void (async () => {
        try {
          const outcome = await fetchAndMerge({ repositoryId, rev });
          setState({ ...idle(), fetchMerge: outcome });
          // **取り込んだときだけ読み直す。** 取ってきただけでも ref は動くので、
          // 一覧（放置警告と ahead/behind）は取り込めなくても取り直す。
          await repositories.refresh();
          if (outcome.fetch !== null) await snapshots.reload();
          if (outcome.merge?.ok === true) onApplied();
        } catch (error) {
          setState({
            ...idle(),
            outcome: { ok: false, message: messageOf(error), details: [], refused: null },
          });
        }
      })();
    },
    [repositoryId, onApplied],
  );

  /**
   * 中止。**効くのは取ってくる間だけ**（`merge --ff-only` は止められない）。
   *
   * 押したことは残す — 画面は「中止しています…」にして、押し直せなくする。
   */
  const cancel = useCallback(() => {
    setState((current) =>
      current.phase === "fetching" ? { ...current, cancelling: true } : current,
    );
    void cancelFetch();
  }, []);

  const dismiss = useCallback(() => {
    setState(idle());
  }, []);

  return {
    ...state,
    askCheckout,
    askMerge,
    askFetchMerge,
    doCheckout,
    doMerge,
    doFetchMerge,
    cancel,
    dismiss,
  };
}

/** 何も走っていない状態。**フィールドを増やしたらここだけ直す。** */
function idle(): WriteState {
  return {
    request: null,
    outcome: null,
    fetchMerge: null,
    phase: null,
    progress: null,
    cancelling: false,
    busy: false,
  };
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : String(error);
}
