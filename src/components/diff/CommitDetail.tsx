/**
 * 差分ペインの 1 段目 — コミット詳細（docs/DESIGN.md §7.3）。
 *
 * full message / 作者・コミッター / 親 / SHA を出す。
 * **マージコミットではここに親のドロップダウンを置く**（§7.4）。差分がどの親との
 * ものか分からないまま眺めることになるのを避けたいので、一覧より上に出す。
 */
import { ja } from "../../i18n/ja";
import type { CommitDetail as Detail, CommitMeta } from "../../lib/ipc";
import { absoluteTime, relativeTime } from "../../lib/relativeTime";

export function CommitDetail({
  detail,
  parentIndex,
  parentsInGraph,
  onParentChange,
  onCopySha,
}: {
  detail: Detail;
  /** 何番目の親と比べているか。ルートコミットでは意味を持たない。 */
  parentIndex: number;
  /**
   * 親のメタ情報。**再取得はしない** — 全コミットが手元にあるので一覧から引く
   * （docs/DESIGN.md §4.1）。読み込んだ集合の外にある親は `null`。
   */
  parentsInGraph: (CommitMeta | null)[];
  onParentChange: (index: number) => void;
  onCopySha: (sha: string) => void;
}) {
  const merge = detail.parents.length > 1;
  // 作者とコミッターが同じことがほとんど。同じなら 1 行に畳んで縦を節約する。
  const sameActor =
    detail.authorName === detail.committerName &&
    detail.authorEmail === detail.committerEmail &&
    detail.authorTime === detail.committerTime;

  return (
    <section className="cdetail">
      <header className="cdetail__head">
        <h2 className="cdetail__subject">
          {detail.subject === "" ? ja.commits.emptySubject : detail.subject}
        </h2>
        {/*
         * マージの親選択は**ヘッダに置く**。facts の中だと、本文が長いときに
         * スクロールで隠れて「どの親との差分を見ているか」が分からなくなる。
         */}
        {merge && (
          <label className="cdetail__parentPick" title={ja.diff.mergeNote}>
            <span className="cdetail__aside">{ja.diff.compareWith}</span>
            <select
              className="select select--small"
              value={parentIndex}
              onChange={(event) => onParentChange(Number(event.target.value))}
            >
              {detail.parents.map((sha, index) => (
                <option key={sha} value={index}>
                  {`${ja.diff.parentNth(index + 1)}: ${describeParent(
                    sha,
                    parentsInGraph[index] ?? null,
                  )}`}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="cdetail__sha"
          title={`${detail.sha}\n${ja.diff.copySha}`}
          onClick={() => onCopySha(detail.sha)}
        >
          {detail.shortSha}
        </button>
      </header>

      {detail.body !== "" && <pre className="cdetail__body">{detail.body}</pre>}

      <dl className="cdetail__facts">
        <dt>{ja.diff.author}</dt>
        <dd>
          {detail.authorName}
          <span className="cdetail__aside">{detail.authorEmail}</span>
          <time
            className="cdetail__aside"
            dateTime={new Date(detail.authorTime * 1000).toISOString()}
            title={absoluteTime(detail.authorTime)}
          >
            {relativeTime(detail.authorTime)}
          </time>
        </dd>

        <dt>{ja.diff.committer}</dt>
        <dd>
          {sameActor ? (
            <span className="cdetail__aside">{ja.diff.sameAsAuthor}</span>
          ) : (
            <>
              {detail.committerName}
              <span className="cdetail__aside">{detail.committerEmail}</span>
              <time
                className="cdetail__aside"
                dateTime={new Date(detail.committerTime * 1000).toISOString()}
                title={absoluteTime(detail.committerTime)}
              >
                {relativeTime(detail.committerTime)}
              </time>
            </>
          )}
        </dd>

        <dt>{ja.diff.parents}</dt>
        <dd>
          {detail.parents.length === 0 ? (
            <span className="cdetail__aside">{ja.diff.noParent}</span>
          ) : (
            detail.parents.map((sha, index) => (
              <span key={sha} className="cdetail__mono">
                {describeParent(sha, parentsInGraph[index] ?? null)}
              </span>
            ))
          )}
        </dd>
      </dl>
    </section>
  );
}

/** 親を「短縮 SHA ＋ subject」で説明する。一覧に無ければ SHA だけ。 */
function describeParent(sha: string, meta: CommitMeta | null): string {
  if (meta === null) return sha.slice(0, 7);
  return `${meta.shortSha} ${meta.subject}`;
}
