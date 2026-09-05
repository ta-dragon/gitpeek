import { ja } from "../../i18n/ja";

/**
 * リポジトリが 1 つも無いときの画面（docs/DESIGN.md §13.2）。
 *
 * **clone はここからも押せること**（T-19）。1 件も登録が無い状態が
 * clone をいちばん使う場面なので、一覧のヘッダだけに置くと届かない。
 */
export function EmptyState({
  onAdd,
  onScan,
  onClone,
  busy,
}: {
  onAdd: () => void;
  onScan: () => void;
  onClone: () => void;
  busy: boolean;
}) {
  return (
    <div className="empty">
      <div className="empty__card">
        <h1 className="empty__title">{ja.emptyState.title}</h1>
        <p className="empty__body">{ja.emptyState.body}</p>
        <div className="empty__actions">
          <button type="button" className="button button--primary" onClick={onAdd} disabled={busy}>
            {ja.repositories.add}
          </button>
          <button type="button" className="button" onClick={onScan} disabled={busy}>
            {ja.repositories.scan}
          </button>
          <button
            type="button"
            className="button"
            onClick={onClone}
            disabled={busy}
            title={ja.repositories.cloneHint}
          >
            {ja.repositories.clone}
          </button>
        </div>
      </div>
    </div>
  );
}
