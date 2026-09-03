import { useCallback, useRef, type ReactNode } from "react";

/**
 * 境界をドラッグして比率を変えられる 2 ペイン。
 *
 * `unit="px"` は固定側ペインの幅（サイドバー・右のコミット情報）、`unit="ratio"` は
 * 割合（グラフと差分の上下分割、T-07）に使う。値の永続化は呼び出し側の責務。
 *
 * `anchor` は **`size` がどちらのペインの寸法か**を決める。右側に固定幅のペインを
 * 置くときは `anchor="second"`（残りを左が取る）。
 */
export function SplitPane({
  direction,
  unit,
  size,
  min,
  max,
  anchor = "first",
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

  return (
    <div ref={containerRef} className={`split split--${direction}`}>
      <div
        className={`split__pane${anchor === "second" ? " split__pane--rest" : ""}`}
        style={anchor === "first" ? fixed : undefined}
      >
        {first}
      </div>
      <div
        className={`split__handle split__handle--${direction}`}
        role="separator"
        aria-orientation={direction === "row" ? "vertical" : "horizontal"}
        onPointerDown={handlePointerDown}
      />
      <div
        className={`split__pane${anchor === "first" ? " split__pane--rest" : ""}`}
        style={anchor === "second" ? fixed : undefined}
      >
        {second}
      </div>
    </div>
  );
}
