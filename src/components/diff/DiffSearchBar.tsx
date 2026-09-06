/**
 * 差分の中の検索（T-25。DESIGN.md §6.5 の `Ctrl+F`）。
 *
 * **探すのは開いているファイルの差分の中だけ。** 判定は純関数
 * （`lib/diffSearch.ts`）で、ここは欄と件数と前後移動だけを持つ。
 *
 * **見つからないときも欄を消さない**（CLAUDE.md §6）。「見つかりません」と
 * 出して、打ち直せる状態のまま残す。
 */
import { useEffect, useRef } from "react";

import { ja } from "../../i18n/ja";
import { bindingOf } from "../../lib/shortcuts";

export function DiffSearchBar({
  query,
  current,
  total,
  onQueryChange,
  onStep,
  onClose,
}: {
  query: string;
  /** いま見ている当たりの番号（0 起点）。**まだどれも見ていなければ -1。** */
  current: number;
  total: number;
  onQueryChange: (query: string) => void;
  onStep: (delta: number) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);

  // 開いたら打てる状態にする（`Ctrl+F` を押してすぐ打ち始められるように）。
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  return (
    <div className="dsearch">
      <input
        ref={input}
        className="input dsearch__input"
        value={query}
        placeholder={ja.diffSearch.placeholder}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          // **入力欄なので、ここのキーは自分で見る**（対応表は横取りしない）。
          if (event.key === "Enter") {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            // **ここで止める。** 外まで届くと、開いているドロワーまで一緒に閉じる。
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="dsearch__count">
        {query.trim() === ""
          ? ja.diffSearch.scope
          : total === 0
            ? ja.diffSearch.none
            : ja.diffSearch.counts(current + 1, total)}
      </span>
      {/* **当たりが無いときも消さない。** 押せない形で残す（CLAUDE.md §6）。 */}
      <button
        type="button"
        className="button button--small"
        disabled={total === 0}
        onClick={() => onStep(-1)}
      >
        {ja.diffSearch.prev}
      </button>
      <button
        type="button"
        className="button button--small"
        disabled={total === 0}
        onClick={() => onStep(1)}
      >
        {ja.diffSearch.next}
      </button>
      <button
        type="button"
        className="button button--small"
        title={bindingOf("close").label}
        onClick={onClose}
      >
        {ja.diffSearch.close}
      </button>
    </div>
  );
}
