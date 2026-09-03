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

export function useFileNavigation({
  keys,
  selected,
  onSelect,
  bodyRef,
}: {
  /** 並んでいる順の鍵。 */
  keys: string[];
  selected: string | null;
  onSelect: (key: string) => void;
  /** `Enter` でフォーカスを移す先（差分本体）。 */
  bodyRef: RefObject<HTMLDivElement | null>;
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
      const target = event.target as HTMLElement | null;
      // 入力欄では横取りしない（SHA ジャンプ欄で Enter が効かなくなる）。
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          step(-1);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          step(1);
        }
        return;
      }

      if (event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const element = bodyRef.current;
        if (element === null) return;
        event.preventDefault();
        element.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [step, bodyRef]);
}
