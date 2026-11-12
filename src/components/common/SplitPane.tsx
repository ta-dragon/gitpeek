import { useCallback, useRef, type ReactNode } from "react";

/**
 * 境界をドラッグして比率を変えられる 2 ペイン。
 *
 * `unit="px"` は固定側ペインの幅（サイドバー・右のコミット情報）、`unit="ratio"` は
 * 割合（グラフと差分の上下分割、T-07）に使う。値の永続化は呼び出し側の責務。
 *
 * `anchor` は **`size` がどちらのペインの寸法か**を決める。右側に固定幅のペインを
 * 置くときは `anchor="second"`（残りを左が取る）。
 *
 * `collapsed` で片側を**細い帯（`collapsedBar`）に畳む**（T-47）。畳んでいる間は境界を出さず、
 * もう片側が残りを全部取る。**`size` は触らない**ので、開けば元の幅・比率に戻る。
 * 畳んだ側の中身は描かない（差分を畳んでいる間に git を呼ばない）。
 */
export function SplitPane({
  direction,
  unit,
  size,
  min,
  max,
  anchor = "first",
  collapsed = null,
  collapsedBar = null,
  onSizeChange,
  first,
  second,
}: {
  direction: "row" | "column";
  unit: "px" | "ratio";
  size: number;
  min: number;
  max: number;
  anchor?: "first" | "second";
  /** 畳んでいる側。null なら畳まない。 */
  collapsed?: "first" | "second" | null;
  /** 畳んだ側に代わりに出す帯（`CollapsedBar`）。 */
  collapsedBar?: ReactNode;
  onSizeChange: (next: number) => void;
  first: ReactNode;
  second: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);

      const move = (moveEvent: PointerEvent) => {
        const container = containerRef.current;
        if (!container) return;
        const box = container.getBoundingClientRect();
        const offset =
          direction === "row" ? moveEvent.clientX - box.left : moveEvent.clientY - box.top;
        const total = direction === "row" ? box.width : box.height;
        // 固定側が second のときは、境界から**逆端まで**が寸法になる。
        const measured = anchor === "first" ? offset : total - offset;
        const value = unit === "px" ? measured : total === 0 ? size : measured / total;
        onSizeChange(Math.min(max, Math.max(min, value)));
      };

      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };

      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    },
    [anchor, direction, max, min, onSizeChange, size, unit],
  );

  const fixed =
    unit === "px"
      ? { flex: `0 0 ${size}px` }
      : { flex: `0 0 ${(size * 100).toFixed(3)}%` };

  /** その側の置き方。**畳んでいれば帯なり、相手が畳んでいれば残りを全部取る。** */
  const paneOf = (side: "first" | "second", content: ReactNode) => {
    if (collapsed === side) {
      return <div className="split__pane split__pane--collapsed">{collapsedBar}</div>;
    }
    const rest = collapsed !== null || anchor !== side;
    return (
      <div
        className={`split__pane${rest ? " split__pane--rest" : ""}`}
        style={rest ? undefined : fixed}
      >
        {content}
      </div>
    );
  };

  return (
    <div ref={containerRef} className={`split split--${direction}`}>
      {paneOf("first", first)}
      {/* 畳んでいる間は境界を出さない（引っ張っても動かせないものを見せない）。 */}
      {collapsed === null && (
        <div
          className={`split__handle split__handle--${direction}`}
          role="separator"
          aria-orientation={direction === "row" ? "vertical" : "horizontal"}
          onPointerDown={handlePointerDown}
        />
      )}
      {paneOf("second", second)}
    </div>
  );
}
