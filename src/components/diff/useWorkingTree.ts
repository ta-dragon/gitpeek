/**
 * 作業ツリーの取得と更新のきっかけ（docs/DESIGN.md §7.5）。
 *
 * **ファイル監視は入れない。** ビルド中のプロジェクトでは大量のイベントが飛ぶ。
 * 更新するのは**リポジトリを選んだとき・ウィンドウに戻ってきたとき・`F5`** の 3 つだけ。
 *
 * 選択中のコミットに関わらず**常に取りに行く**。擬似行を出すかどうかの判断に要るので、
 * 作業ツリーを開いていなくても状態は要る。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { loadWorkingTree, type WorkingTree } from "../../lib/ipc";

export type WorkingTreeState = {
  tree: WorkingTree | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

export function useWorkingTree(repositoryId: string | null): WorkingTreeState {
  const [tree, setTree] = useState<WorkingTree | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const latest = useRef(0);

  const reload = useCallback(() => setNonce((count) => count + 1), []);

  useEffect(() => {
    const request = (latest.current += 1);

    if (repositoryId === null) {
      setTree(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    void loadWorkingTree(repositoryId)
      .then((loaded) => {
        if (request !== latest.current) return;
        setTree(loaded);
        setLoading(false);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (request !== latest.current) return;
        setTree(null);
        setLoading(false);
        setError(messageOf(caught));
      });
  }, [repositoryId, nonce]);

  /*
   * ウィンドウに戻ってきたら取り直す。**外部の CLI で `git add` した直後**が
   * まさにこの瞬間なので、ここを外すと画面が古いまま残る。
   */
  useEffect(() => {
    if (repositoryId === null) return;
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [repositoryId, reload]);

  // `F5` は「グラフ再読込」（docs/DESIGN.md §6.5）。作業ツリーもそこに乗せる。
  useEffect(() => {
    if (repositoryId === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F5") return;
      // ブラウザの再読込は要らない（Tauri でも WebView の再読込は起きる）。
      event.preventDefault();
      reload();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [repositoryId, reload]);

  return { tree, loading, error, reload };
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : String(error);
}
