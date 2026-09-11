/**
 * ファイル一覧のキーボード操作（docs/DESIGN.md §6.5）。
 *
 * `Alt+↑` / `Alt+↓` で前 / 次のファイル、`Enter` で差分ペインへフォーカス。
 * **コミットの一覧と作業ツリーの一覧で同じものを使う** — 見ているものが違うだけで、
 * 操作は同じであるべきなので。
 *
 * 鍵は**文字列 1 本**にしてある。作業ツリーでは同じパスがステージ済みと未ステージの
 * 両方に出るので、パスだけでは前後が決まらない。
 */
import { useCallback, useEffect, type RefObject } from "react";

import { isTyping, matches } from "../lib/shortcuts";

export function useFileNavigation({
  keys,
  selected,
  onSelect,
  focusRef,
}: {
  /** 並んでいる順の鍵。 */
  keys: string[];
  selected: string | null;
  onSelect: (key: string) => void;
  /**
   * `Enter` でフォーカスを移す先（差分ペインの外枠 `.dpane`）。
   *
   * **スクロールする要素ではない。** 仮想スクロールは `.dpane__body` に付けた別の ref を見る
   * （1 本を両方に付けると描く行が固まる。docs/DESIGN.md §17.1）。
   */
  focusRef: RefObject<HTMLDivElement | null>;
}) {
  const step = useCallback(
    (delta: number) => {
      if (keys.length === 0) return;
      const current = keys.indexOf(selected ?? "");
      const next = Math.min(keys.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta));
      onSelect(keys[next]);
    },
    [keys, selected, onSelect],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 入力欄では横取りしない（SHA ジャンプ欄で Enter が効かなくなる）。
      if (isTyping(event.target)) return;

      if (matches(event, "filePrev")) {
        event.preventDefault();
        step(-1);
        return;
      }
      if (matches(event, "fileNext")) {
        event.preventDefault();
        step(1);
        return;
      }

      if (matches(event, "focusDiff")) {
        const element = focusRef.current;
        if (element === null) return;
        event.preventDefault();
        element.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [step, focusRef]);
}
