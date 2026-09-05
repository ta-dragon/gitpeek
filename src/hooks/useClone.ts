/**
 * clone の実行と進捗（T-19。docs/DESIGN.md §8.4）。
 *
 * 流れは **入力 → 実行 → 登録して開く** の 1 本だけ。
 *
 * **成功したら黙って閉じる。** 結果ダイアログを挟むと、開いたリポジトリを見る前に
 * もう 1 回クリックさせることになる。失敗と中止のときだけ結果を出す
 * （何が起きたか分からないまま閉じないため）。
 *
 * **登録に使うのは Rust が返したパス。** 画面のプレビューは目安であり、
 * 実際に作られた場所とは限らない。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelClone,
  cloneRepository,
  onCloneProgress,
  type CloneOutcome,
  type CloneProgress,
  type CloneRequest,
} from "../lib/ipc";
import * as repositories from "../store/repositories";
import { updateSettings } from "../store/settings";

export type CloneState = {
  /** ダイアログを開いているか。 */
  open: boolean;
  /** 実行中。**閉じさせない。** */
  busy: boolean;
  /** 実行中の途中経過。段階が変わるまでは null。 */
  progress: CloneProgress | null;
  /** 失敗・中止の結果。成功したときは入らない（そのまま閉じる）。 */
  outcome: CloneOutcome | null;
  /** 中止を頼んだ。git が終わるまでは戻ってこない。 */
  cancelling: boolean;
};

const CLOSED: CloneState = {
  open: false,
  busy: false,
  progress: null,
  outcome: null,
  cancelling: false,
};

export function useClone(onDone: (message: string) => void) {
  const [state, setState] = useState<CloneState>(CLOSED);

  // **走っている間は次を始めない。** 二重に走らせると、同じフォルダを
  // 2 つの git が奪い合う。
  const running = useRef(false);

  useEffect(() => {
    const unlisten = onCloneProgress((progress) => {
      setState((current) => (current.busy ? { ...current, progress } : current));
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  /** ダイアログを出す。**状態の `open` と名前が衝突しないよう `show`。** */
  const show = useCallback(() => {
    if (running.current) return;
    setState({ ...CLOSED, open: true });
  }, []);

  const start = useCallback(
    async (request: CloneRequest, rememberParent: boolean) => {
      if (running.current) return;
      running.current = true;
      setState({ open: true, busy: true, progress: null, outcome: null, cancelling: false });

      try {
        const outcome = await cloneRepository(request);

        if (outcome.status === "success" && outcome.path !== null) {
          // **既定の保存先を覚えるのは成功したときだけ。** 失敗した場所を
          // 次回の既定にすると、同じ失敗を繰り返す入口になる。
          if (rememberParent) {
            await updateSettings((current) => ({
              ...current,
              workspaceRoot: request.parentDirectory,
            }));
          }
          // **Rust が返したパスで登録する。** 登録と選択は既存の 1 本を通す。
          await repositories.add(outcome.path);
          setState(CLOSED);
          onDone(outcome.message);
          return;
        }

        setState({
          open: true,
          busy: false,
          progress: null,
          outcome,
          cancelling: false,
        });
      } catch (error) {
        // 呼び出し自体が失敗した（git が見つからない等）。
        setState({
          open: true,
          busy: false,
          progress: null,
          outcome: {
            status: "failed",
            message: messageOf(error),
            lines: [],
            durationMs: 0,
            path: null,
            leftover: null,
          },
          cancelling: false,
        });
      } finally {
        // **必ず外す。** 立てっぱなしにすると、このセッションでは二度と clone できない。
        running.current = false;
      }
    },
    [onDone],
  );

  /** 中止。**残骸は Rust 側が消す**（自分が作ったフォルダだけ）。 */
  const cancel = useCallback(() => {
    setState((current) => (current.busy ? { ...current, cancelling: true } : current));
    void cancelClone();
  }, []);

  /**
   * 結果を消して入力へ戻る。**ダイアログは閉じない**ので、入力欄はそのまま残る。
   *
   * 「そのフォルダは既にあります」で止まったときに、名前を変えて押し直すのが
   * いちばんありそうな続きなのに、閉じてしまうと URL から入れ直しになる。
   */
  const back = useCallback(() => {
    setState((current) => (current.busy ? current : { ...current, outcome: null }));
  }, []);

  /** 閉じる。**実行中は閉じさせない**（結果を見逃す）。 */
  const dismiss = useCallback(() => {
    setState((current) => (current.busy ? current : CLOSED));
  }, []);

  return {
    ...state,
    show,
    start: (request: CloneRequest, rememberParent: boolean) =>
      void start(request, rememberParent),
    cancel,
    back,
    dismiss,
  };
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : String(error);
}
