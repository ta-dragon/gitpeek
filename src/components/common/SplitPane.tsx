import { useCallback, useRef, type ReactNode } from "react";

/**
 * 境界をドラッグして比率を変えられる 2 ペイン。
 *
 * `unit="px"` は先頭ペインの幅（サイドバー）、`unit="ratio"` は先頭ペインの割合
 * （グラフと差分の上下分割、T-07）に使う。値の永続化は呼び出し側の責務。
 */
export function SplitPane({
  direction,
  unit,
  size,
  min,
  max,
  onSizeChange,
  first,
  second,
}: {
  direction: "row" | "column";
  unit: "px" | "ratio";
  size: number;
  min: number;
  max: number;
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
        const value = unit === "px" ? offset : total === 0 ? size : offset / total;
        onSizeChange(Math.min(max, Math.max(min, value)));
      };

      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };

      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    },
    [direction, max, min, onSizeChange, size, unit],
  );

  const firstStyle =
    unit === "px"
      ? { flex: `0 0 ${size}px` }
      : { flex: `0 0 ${(size * 100).toFixed(3)}%` };

  return (
    <div ref={containerRef} className={`split split--${direction}`}>
      <div className="split__pane" style={firstStyle}>
        {first}
      </div>
      <div
        className={`split__handle split__handle--${direction}`}
        role="separator"
        aria-orientation={direction === "row" ? "vertical" : "horizontal"}
        onPointerDown={handlePointerDown}
      />
      <div className="split__pane split__pane--rest">{second}</div>
    </div>
  );
}
