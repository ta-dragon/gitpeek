/**
 * レビュー履歴（T-23。DESIGN.md §12.4）。
 *
 * **上書きせず積んである**ので、同じ差分を 2 回レビューすれば 2 件並ぶ。
 * **読めないものも消さずに理由付きで並べる**（CLAUDE.md §6）。
 */
import { ja } from "../../i18n/ja";
import type { ReviewIndexRow } from "../../lib/ipc";
import { historyLabel, historyTime } from "../../lib/reviewPlan";

export function ReviewHistory({
  rows,
  error,
  where,
  onOpen,
}: {
  rows: ReviewIndexRow[];
  error: string | null;
  /** 保存先。**0 件のときに場所を出す**ため。 */
  where: string | null;
  onOpen: (file: string) => void;
}) {
  return (
    <div className="review__panel">
      {error !== null && <p className="review__error">{error}</p>}

      {rows.length === 0 ? (
        <>
          <p className="review__note">{ja.review.history.empty}</p>
          {where !== null && <p className="review__note">{ja.review.history.emptyWhere(where)}</p>}
        </>
      ) : (
        <ul className="review__history">
          {rows.map((row) => (
            <li
              key={row.file}
              className={
                row.unreadable === null ? "review__history-item" : "review__history-item review__history-item--broken"
              }
            >
              <button
                type="button"
                className="review__history-open"
                // 読めないものは開けないが、**一覧からは消さない。**
                disabled={row.unreadable !== null}
                onClick={() => onOpen(row.file)}
              >
                <span className="review__history-time">{historyTime(row.savedAt)}</span>
                <span className="review__history-model">{row.model}</span>
                <span className="review__history-label">{historyLabel(row)}</span>
              </button>
              {row.unreadable !== null && (
                <p className="review__history-reason">{row.unreadable}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
