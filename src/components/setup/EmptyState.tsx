import { ja } from "../../i18n/ja";

/**
 * リポジトリが 1 つも無いときの画面（docs/DESIGN.md §13.2）。
 *
 * clone は T-19 まで無効。押せないボタンを消すのではなく、
 * 「あるが未実装」と分かる形で残す。
 */
export function EmptyState({
  onAdd,
  onScan,
  busy,
}: {
  onAdd: () => void;
  onScan: () => void;
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
          <button type="button" className="button" disabled title={ja.emptyState.cloneDisabled}>
            {ja.repositories.clone}
            <span className="badge badge--muted">{ja.common.notImplemented}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
