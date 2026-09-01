import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type ContextMenuItem = {
  label: string;
  onSelect: () => void;
  /** 取り消しの効かない操作を赤く出す。 */
  danger?: boolean;
  disabled?: boolean;
  /** 補足説明（ツールチップ）。 */
  title?: string;
};

/**
 * 右クリックメニュー。
 *
 * OS のメニュー API ではなく DOM で描く。テーマトークンでそのまま色を合わせられ、
 * capabilities に権限を足さずに済むため。
 *
 * 閉じる条件は「メニュー外の押下 / `Esc` / スクロール / ウィンドウのフォーカス喪失」。
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // 画面外へはみ出したら内側へ寄せる。サイドバー下端で開いたときに切れないように。
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    // 一覧をスクロールしたらメニューだけ取り残されるので閉じる。
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
  }, []);

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={{ left: position.left, top: position.top }}
      // ここで止めないと、項目を押した瞬間に window の mousedown が先に閉じてしまう。
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`menu__item${item.danger === true ? " menu__item--danger" : ""}`}
          title={item.title}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
