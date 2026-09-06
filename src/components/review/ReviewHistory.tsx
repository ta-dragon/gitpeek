/**
 * レビュー履歴（T-23。DESIGN.md §12.4）。
 *
 * **上書きせず積んである**ので、同じ差分を 2 回レビューすれば 2 件並ぶ。
 * **読めないものも消さずに理由付きで並べる**（CLAUDE.md §6）。
 *
 * **どのリポジトリの、何をレビューしたのかを出す**（利用者の要望。2026-09-06）。
 * 日時とモデルだけだと、何度もレビューしたときにどれがどれだか読めない。
 * 文言の組み立ては純関数（`lib/reviewTarget.ts`）。
 */
import { ja } from "../../i18n/ja";
import type { ReviewIndexRow } from "../../lib/ipc";
import { historyLabel, historyTime } from "../../lib/reviewPlan";
import { describeTarget, type TargetContext } from "../../lib/reviewTarget";

export function ReviewHistory({
  rows,
  error,
  where,
  context,
  onOpen,
}: {
  rows: ReviewIndexRow[];
  error: string | null;
  /** 保存先。**0 件のときに場所を出す**ため。 */
  where: string | null;
  /** どのリポジトリの履歴か ／ コミットの要約を引く手立て。 */
  context: TargetContext;
  onOpen: (file: string) => void;
}) {
  return (
    <div className="review__panel">
      {/* **どのリポジトリの履歴かを必ず出す。** 0 件でも読めるように上に置く。 */}
      {context.repositoryName !== null && (
        <p className="review__history-of">{ja.review.history.of(context.repositoryName)}</p>
      )}

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
                {/* **何をレビューしたのか。** 読めない 1 件でも文言は出る。 */}
                <span className="review__history-target">
                  {describeTarget(row.source, context)}
                </span>
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
