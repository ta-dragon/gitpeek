/**
 * 実行中と結果の表示（T-23）。
 *
 * **どちらも同じ部品で出す。** 実行中は流れてきた本文をそのまま、
 * 終わったら構造化した指摘を出すだけの違いなので、画面を 2 つ作らない。
 *
 * **構造化に失敗した結果を捨てない**（DESIGN.md §10.6）。`markdown` が
 * 入っていれば理由を添えてそのまま出す。
 */
import { useState } from "react";

import { ja } from "../../i18n/ja";
import { formatRawBody, headlineLines } from "../../lib/llmMessage";
import type { Finding, LlmError, ReviewText, StoredReview } from "../../lib/ipc";
import { bySeverity, countFindings, outcomeOf } from "../../lib/reviewFindings";
import type { FileProgress } from "../../hooks/useReview";

function Severity({ finding }: { finding: Finding }) {
  return (
    <span className={`review__severity review__severity--${finding.severity}`}>
      {finding.severity}
    </span>
  );
}

function FindingRow({ finding, onJump }: { finding: Finding; onJump: (() => void) | null }) {
  return (
    <li className="review__finding">
      <div className="review__finding-head">
        <Severity finding={finding} />
        <span className="review__finding-title">{finding.title}</span>
        {finding.line !== null && (
          <button
            type="button"
            className="review__finding-line"
            // 行へ飛べないときも**消さない**。押せない形で残す。
            disabled={onJump === null}
            onClick={() => onJump?.()}
          >
            {finding.line}
          </button>
        )}
      </div>
      <p className="review__finding-message">{finding.message}</p>
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

function TextBlock({ text, onJump }: { text: ReviewText; onJump: ((line: number) => void) | null }) {
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
              onJump={
                onJump !== null && finding.line !== null ? () => onJump(finding.line ?? 0) : null
              }
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

/** 走り終えた（または履歴から開いた）結果。 */
export function ReviewResult({
  stored,
  runError,
  onJump,
}: {
  stored: StoredReview | null;
  runError: string | null;
  /** 指摘から差分の行へ飛ぶ。飛べないときは `null`。 */
  onJump: ((path: string, line: number) => void) | null;
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
      <div className="review__counts">
        <span>{ja.review.findingsHeading(countFindings(run))}</span>
        {run.failed > 0 && <span className="review__warn">{ja.review.history.failed(run.failed)}</span>}
        {run.cancelled && <span className="review__warn">{ja.review.history.cancelled}</span>}
      </div>

      {run.summary !== null && (
        <>
          <h3 className="review__heading">{ja.review.summaryHeading}</h3>
          <TextBlock text={run.summary} onJump={null} />
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
              onJump={onJump === null ? null : (line) => onJump(file.path, line)}
            />
          )}
        </section>
      ))}
    </div>
  );
}
