/**
 * fetch の進行と結果（docs/DESIGN.md §8.3）。
 *
 * バーは 2 本ある。**上がリポジトリ数、下が 1 件の中の進捗。** 混ぜると、
 * リポジトリを跨いだ瞬間にバーが戻って見える。
 *
 * **中止しても、そこまでに取り込まれた ref は戻らない。** 結果の文言でそう伝える
 * （黙って閉じない）。
 */
import { useEffect } from "react";

import { ja } from "../../i18n/ja";
import {
  currentTarget,
  isDone,
  summarize,
  type FetchResult,
  type FetchRun,
  type FetchTarget,
} from "../../lib/fetchState";
import type { FetchProgress } from "../../lib/ipc";
import { LoadProgress } from "./LoadProgress";

export function FetchDialog({
  run,
  progress,
  onCancel,
  onClose,
}: {
  run: FetchRun;
  progress: FetchProgress | null;
  onCancel: () => void;
  onClose: () => void;
}) {
  const done = isDone(run);
  const target = currentTarget(run);
  const summary = summarize(run);

  // **走っている間は `Esc` で閉じない。** 中止は明示的に押させる（docs/DESIGN.md §6.5 の
  // 「ドロワー / パネルを閉じる」は、結果を読み終えたあとにだけ当てはまる）。
  useEscape(done ? onClose : null);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={ja.fetch.title}>
      <div className="modal__box modal__box--wide">
        <h2 className="modal__title">{done ? ja.fetch.summaryTitle : ja.fetch.title}</h2>

        {run.targets.length > 1 && (
          <LoadProgress
            label={ja.fetch.ofRepositories(run.results.length, run.targets.length)}
            done={run.results.length}
            total={run.targets.length}
            // リポジトリ数は数え上げた正確な値。経過時間はこのバーでは意味が無い。
            estimated={false}
            elapsedMs={null}
          />
        )}

        {!done && target !== null && (
          <LoadProgress
            // git の見出しをそのまま出す。**翻訳されていることがある。**
            label={progress?.label ?? ja.fetch.running(target.name)}
            done={progress?.done ?? 0}
            total={progress?.total ?? null}
            // git が数えた実数なので「約」を付けない。
            estimated={false}
            elapsedMs={progress?.elapsedMs ?? 0}
          />
        )}

        {done && (
          <p className="modal__lead">
            {ja.fetch.summary(summary.success, summary.failed)}
            {/* **中止と未実行を落とさない。** 落とすと「成功 0 / 失敗 0」だけが残り、
                何が起きたのか分からなくなる。 */}
            {summary.cancelled > 0 && ` / ${ja.fetch.cancelledCount(summary.cancelled)}`}
            {summary.skipped > 0 && ` / ${ja.fetch.skipped(summary.skipped)}`}
          </p>
        )}

        {run.results.length > 0 && (
          <ul className="fetchResults">
            {run.results.map((result) => (
              <ResultRow key={result.id} result={result} />
            ))}
          </ul>
        )}

        <div className="modal__actions">
          {done ? (
            <button type="button" className="button button--primary" onClick={onClose}>
              {ja.fetch.close}
            </button>
          ) : (
            <button type="button" className="button" onClick={onCancel} disabled={run.cancelled}>
              {run.cancelled ? ja.fetch.cancelling : ja.fetch.cancel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultRow({ result }: { result: FetchResult }) {
  const label =
    result.status === "success"
      ? ja.fetch.statusSuccess
      : result.status === "failed"
        ? ja.fetch.statusFailed
        : ja.fetch.statusCancelled;

  return (
    <li className={`fetchResults__row fetchResults__row--${result.status}`}>
      <span className="fetchResults__name">{result.name}</span>
      <span className="badge">{label}</span>
      <span className="fetchResults__message">{result.message}</span>
      {/* 生の行は畳んでおく（docs/DESIGN.md §3.6「人間向けメッセージ＋展開で生 stderr」）。 */}
      {result.lines.length > 0 && (
        <details className="fetchResults__detail">
          <summary>{ja.fetch.details}</summary>
          <pre className="fetchResults__raw">{result.lines.join("\n")}</pre>
        </details>
      )}
    </li>
  );
}

/**
 * 一括 fetch の実行前確認（docs/DESIGN.md §8.3）。
 *
 * **一括のときだけ、1 回だけ出す。** 1 件ずつ聞くと、10 件で 10 回聞くことになる。
 */
export function FetchConfirm({
  targets,
  onConfirm,
  onCancel,
}: {
  targets: FetchTarget[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEscape(onCancel);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={ja.fetch.confirmTitle}>
      <div className="modal__box">
        <h2 className="modal__title">{ja.fetch.confirmTitle}</h2>
        <p className="modal__lead">{ja.fetch.confirmBody(targets.length)}</p>
        {/* 認証ウィンドウが出る可能性を先に伝える。突然前面に出ると事故に見える。 */}
        <p className="modal__note">{ja.fetch.confirmAuth}</p>

        <div className="modal__actions">
          <button type="button" className="button" onClick={onCancel}>
            {ja.fetch.confirmCancel}
          </button>
          <button type="button" className="button button--primary" onClick={onConfirm}>
            {ja.fetch.confirmRun}
          </button>
        </div>
      </div>
    </div>
  );
}

/** `Esc` で閉じる。`onEscape` が null の間は何もしない。 */
function useEscape(onEscape: (() => void) | null): void {
  useEffect(() => {
    if (onEscape === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onEscape]);
}
