/**
 * 実行中と結果の表示（T-23）。
 *
 * **どちらも同じ部品で出す。** 実行中は流れてきた本文をそのまま、
 * 終わったら構造化した指摘を出すだけの違いなので、画面を 2 つ作らない。
 *
 * **構造化に失敗した結果を捨てない**（DESIGN.md §10.6）。`markdown` が
 * 入っていれば理由を添えてそのまま出す。
 *
 * **指摘は押せる**（利用者の要望。2026-09-06）。押すとそのファイルを開き、
 * 差分の該当行まで動かす。**当たらない行を指した指摘はそう書く** —
 * 押しても何も起きないように見えるのを避ける（CLAUDE.md §6）。
 */
import { useState } from "react";

import { ja } from "../../i18n/ja";
import { formatRawBody, headlineLines } from "../../lib/llmMessage";
import type { Finding, LlmError, ReviewText, StoredReview } from "../../lib/ipc";
import {
  bySeverity,
  countFindings,
  landsOn,
  outcomeOf,
  type LineLookup,
} from "../../lib/reviewFindings";
import { describeTarget, type TargetContext } from "../../lib/reviewTarget";
import { historyTime } from "../../lib/reviewPlan";
import type { FileProgress } from "../../hooks/useReview";

function Severity({ finding }: { finding: Finding }) {
  return (
    <span className={`review__severity review__severity--${finding.severity}`}>
      {finding.severity}
    </span>
  );
}

/**
 * 指摘 1 件。**行が当たるかどうかで見え方を変える。**
 *
 * `lands` は純関数（`lib/reviewFindings.ts`）が決める。
 * `null` は「開いていないファイルなので分からない」で、**何も書かない**
 * （分からないものを「当たらなかった」と書くと嘘になる）。
 */
function FindingRow({
  finding,
  lands,
  onJump,
}: {
  finding: Finding;
  lands: boolean | null;
  onJump: (() => void) | null;
}) {
  const note =
    finding.line === null
      ? ja.review.wholeFileNote
      : lands === false
        ? ja.review.offDiffNote
        : null;

  // **`button` の中に置けるのは文章の断片だけ**なので、本文も `span` で出す。
  const body = (
    <>
      <span className="review__finding-head">
        <Severity finding={finding} />
        <span className="review__finding-title">{finding.title}</span>
        {finding.line !== null && <span className="review__finding-line">{finding.line}</span>}
      </span>
      <span className="review__finding-message">{finding.message}</span>
      {note !== null && <span className="review__finding-note">{note}</span>}
    </>
  );

  return (
    <li className="review__finding">
      {onJump === null ? (
        <div className="review__finding-body">{body}</div>
      ) : (
        <button
          type="button"
          className="review__finding-body review__finding-body--jump"
          title={
            finding.line === null || lands === false
              ? ja.review.jumpFileOnlyHint
              : ja.review.jumpHint
          }
          onClick={onJump}
        >
          {body}
        </button>
      )}
    </li>
  );
}

/** 失敗は接続テストと同じ 3 段で出す（見出し ＋ 言い分 ＋ 展開で生の応答）。 */
function Failure({ error }: { error: LlmError }) {
  const [open, setOpen] = useState(false);
  const raw = formatRawBody(error.detail);

  return (
    <div className="review__failure">
      {headlineLines(error.message).map((line, index) => (
        <p key={index} className="review__failure-line">
          {line}
        </p>
      ))}
      {raw.text !== "" && (
        <>
          <button type="button" className="button button--small" onClick={() => setOpen(!open)}>
            {ja.review.detail}
          </button>
          {open && <pre className="review__raw">{raw.text}</pre>}
        </>
      )}
    </div>
  );
}

function TextBlock({
  text,
  path,
  lookup,
  onJump,
}: {
  text: ReviewText;
  /** どのファイルの結果か。**全体サマリでは `null`**（行に結び付けない）。 */
  path: string | null;
  lookup: LineLookup;
  onJump: ((line: number | null) => void) | null;
}) {
  // **構造化に失敗していたら、理由を添えて生出力をそのまま出す。**
  if (text.markdown !== null) {
    return (
      <div className="review__fallback">
        <p className="review__note">{text.fallbackReason ?? ja.review.fallbackDefault}</p>
        <pre className="review__raw">{text.markdown}</pre>
      </div>
    );
  }

  const findings = bySeverity(text.findings);
  return (
    <>
      {text.summary !== "" && <p className="review__summary">{text.summary}</p>}
      {findings.length === 0 ? (
        <p className="review__note">{ja.review.noFindings}</p>
      ) : (
        <ul className="review__findings">
          {findings.map((finding, index) => (
            <FindingRow
              key={index}
              finding={finding}
              lands={path === null ? null : landsOn(lookup, path, finding.line)}
              // **行が当たらなくても押せる。** ファイルを開くところまではできる。
              onJump={onJump === null ? null : () => onJump(finding.line)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** 実行中。**流れてきた本文をそのまま見せる**（ローカルは遅いので体感が変わる）。 */
export function RunningList({
  progress,
  summaryStreamed,
}: {
  progress: FileProgress[];
  summaryStreamed: string;
}) {
  return (
    <div className="review__panel">
      <ul className="review__progress">
        {progress.map((file) => (
          <li key={file.path} className={`review__progress-item review__progress-item--${file.status}`}>
            <div className="review__progress-head">
              <span className="review__file-path">{file.path}</span>
              <span className="review__status">{ja.review.status[statusKey(file.status)]}</span>
            </div>
            {file.status === "running" && file.streamed !== "" && (
              <pre className="review__stream">{file.streamed}</pre>
            )}
            {file.result?.error != null && <Failure error={file.result.error} />}
          </li>
        ))}
      </ul>
      {summaryStreamed !== "" && (
        <>
          <h3 className="review__heading">{ja.review.summaryHeading}</h3>
          <pre className="review__stream">{summaryStreamed}</pre>
        </>
      )}
    </div>
  );
}

function statusKey(status: FileProgress["status"]): "waiting" | "running" | "done" | "failed" {
  return status;
}

/**
 * 何をレビューしたのか（利用者の要望。2026-09-06）。
 *
 * **履歴から開いた 1 件でも、走り終えた直後でも同じものを出す。**
 * 日時とモデルだけでは、何度もレビューしたときにどれがどれだか読めない。
 * 文言の組み立ては純関数（`lib/reviewTarget.ts`）。
 */
function ResultMeta({ stored, context }: { stored: StoredReview; context: TargetContext }) {
  const rows: [string, string][] = [];
  if (context.repositoryName !== null) {
    rows.push([ja.review.target.repository, context.repositoryName]);
  }
  rows.push([ja.review.target.what, describeTarget(stored.run.source, context)]);
  rows.push([ja.review.target.when, historyTime(stored.savedAt)]);
  rows.push([
    ja.review.target.model,
    `${stored.run.model}（${stored.profile.name}）`,
  ]);

  return (
    <dl className="review__meta">
      {rows.map(([key, value]) => (
        <div key={key} className="review__meta-row">
          <dt className="review__meta-key">{key}</dt>
          <dd className="review__meta-value">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 走り終えた（または履歴から開いた）結果。 */
export function ReviewResult({
  stored,
  runError,
  context,
  lookup,
  onJump,
}: {
  stored: StoredReview | null;
  runError: string | null;
  /** 「何をレビューしたのか」を書くための手掛かり。 */
  context: TargetContext;
  /** いま差分ペインに出ているファイルの行。**当たらなかった指摘を明記する**ため。 */
  lookup: LineLookup;
  /** 指摘から差分へ飛ぶ。飛べないときは `null`。 */
  onJump: ((path: string, line: number | null) => void) | null;
}) {
  if (runError !== null) {
    return (
      <div className="review__panel">
        <p className="review__error">{runError}</p>
      </div>
    );
  }
  if (stored === null) {
    return (
      <div className="review__panel">
        <p className="review__note">{ja.review.emptyResult}</p>
      </div>
    );
  }

  const { run } = stored;
  return (
    <div className="review__panel">
      <ResultMeta stored={stored} context={context} />

      <div className="review__counts">
        <span>{ja.review.findingsHeading(countFindings(run))}</span>
        {run.failed > 0 && <span className="review__warn">{ja.review.history.failed(run.failed)}</span>}
        {run.cancelled && <span className="review__warn">{ja.review.history.cancelled}</span>}
      </div>

      {run.summary !== null && (
        <>
          <h3 className="review__heading">{ja.review.summaryHeading}</h3>
          {/* 全体サマリの指摘は特定のファイルのものではないので行へ結び付けない。 */}
          <TextBlock text={run.summary} path={null} lookup={lookup} onJump={null} />
        </>
      )}

      {run.files.map((file) => (
        <section key={file.path} className="review__file-result">
          <h3 className="review__heading">{file.path}</h3>
          {outcomeOf(file) === "failed" && file.error !== null && <Failure error={file.error} />}
          {outcomeOf(file) === "empty" && <p className="review__note">{ja.review.emptyResult}</p>}
          {file.text !== null && (
            <TextBlock
              text={file.text}
              path={file.path}
              lookup={lookup}
              onJump={onJump === null ? null : (line) => onJump(file.path, line)}
            />
          )}
        </section>
      ))}
    </div>
  );
}
