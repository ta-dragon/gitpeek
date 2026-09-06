/**
 * `Esc` で閉じる（T-25 で 1 つに寄せた）。
 *
 * **同じものが 3 か所に写してあった**（`ConfirmDialog` / `ProgressDialog` /
 * `LlmProfiles`）。キーの形を対応表（`lib/shortcuts.ts`）に集めるにあたり、
 * 判定もここへ寄せる — **写しが残っていると、表を直しても効かない場所ができる。**
 */
import { useEffect } from "react";

import { matches } from "../lib/shortcuts";

/**
 * `onEscape` が `null` のときは何もしない（閉じられないダイアログ）。
 *
 * **入力欄でも効かせる。** ダイアログの中で打っている最中に `Esc` で閉じたい
 * （文字を打つ邪魔にならないキーなので、他のショートカットとは扱いが違う）。
 */
export function useEscape(onEscape: (() => void) | null): void {
  useEffect(() => {
    if (onEscape === null) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!matches(event, "close")) return;
      event.preventDefault();
      onEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onEscape]);
}
