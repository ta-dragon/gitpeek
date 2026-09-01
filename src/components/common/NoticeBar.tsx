import { ja } from "../../i18n/ja";

/**
 * 画面上部に出す警告バー。
 *
 * 今の用途は「壊れた settings.json を退避して既定値で起動した」の通知。
 * **黙って捨てない**ことが要件なので、退避先のパスを必ず見せる（CLAUDE.md §5）。
 */
export function NoticeBar({
  title,
  detail,
  onDismiss,
}: {
  title: string;
  detail?: string;
  onDismiss: () => void;
}) {
  return (
    <div className="notice" role="status">
      <div className="notice__text">
        <span className="notice__title">{title}</span>
        {detail !== undefined && <span className="notice__detail">{detail}</span>}
      </div>
      <button type="button" className="button" onClick={onDismiss}>
        {ja.common.close}
      </button>
    </div>
  );
}
