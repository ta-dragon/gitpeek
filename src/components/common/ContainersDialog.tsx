/**
 * 「このブランチを取り込んでいる可能性があるブランチを調べる…」（T-38。T-39 を取り込んだ。
 * docs/DESIGN.md §7.6.1）。
 *
 * 開いたらすぐ調べ始める。相手を選ぶのは Rust（このブランチより後に動いたブランチ全部）で、
 * **逐次に、時間がかかってよい**（利用者の指定）。進み具合と残りの目安を出し、途中で止められる。
 * **止めても、そこまでに見つかったものは残し「全部ではない」と書く**（コミット検索と同じ）。
 *
 * **ここで調べた結果は印にしない。** 印は幹と比べた結果だけで、1 つの印が相手によって意味を
 * 変えないようにする（2026-09-18 に利用者が了承）。
 *
 * 出し分けは `lib/containment.ts`、文言の引き当ては `containmentText.ts`。
 */
import { useEffect, useRef, useState } from "react";

import { useEscape } from "../../hooks/useEscape";
import { ja } from "../../i18n/ja";
import {
  containerRows,
  containersProgressView,
  containersSummary,
  type ContainersSummary,
} from "../../lib/containment";
import {
  cancelFindContainers,
  findContainers,
  onContainersProgress,
  type ContainerSearch,
  type RefEntry,
} from "../../lib/ipc";
import { hintText, markText } from "./containmentText";

type Progress = { done: number; total: number; found: number; elapsedMs: number };

export function ContainersDialog({
  repositoryId,
  branch,
  refs,
  onJumpCommit,
  onClose,
}: {
  repositoryId: string;
  /** 調べるブランチ。 */
  branch: RefEntry;
  refs: RefEntry[];
  /** コミットへ飛ぶ。**飛べない理由は呼ぶ側が出す。** */
  onJumpCommit: (sha: string) => void;
  onClose: () => void;
}) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [search, setSearch] = useState<ContainerSearch | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  /** 閉じたあとに届いた結果を捨てる。 */
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const started = performance.now();
    const unlisten = onContainersProgress((event) => {
      if (!alive.current || event.repositoryId !== repositoryId || event.branch !== branch.name) {
        return;
      }
      setProgress({
        done: event.done,
        total: event.total,
        found: event.found,
        elapsedMs: performance.now() - started,
      });
    });
    void (async () => {
      try {
        const result = await findContainers(repositoryId, branch.name);
        if (alive.current) setSearch(result);
      } catch (error) {
        if (alive.current) setFailure(typeof error === "string" ? error : String(error));
      }
    })();
    return () => {
      alive.current = false;
      void unlisten.then((stop) => stop());
    };
  }, [repositoryId, branch.name]);

  const running = search === null && failure === null;

  const stop = () => {
    setStopping(true);
    void cancelFindContainers();
  };

  // **走っている間に閉じたら止める。** 画面から消えたものに数分 git を回させない。
  const close = () => {
    if (running) void cancelFindContainers();
    onClose();
  };
  useEscape(close);

  const title = ja.containment.containersTitle(branch.shortName);
  const rows = search === null ? [] : containerRows(search.found, refs);
  const tipOf = (name: string) => refs.find((entry) => entry.name === name)?.target ?? null;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal__box modal__box--wide">
        <h2 className="modal__title">{title}</h2>
        <p className="modal__lead">{ja.containment.containersLead}</p>

        <div className="modal__body">
          {failure !== null && <p className="modal__blocker">{failure}</p>}

          {running && <ProgressLine progress={progress} stopping={stopping} />}

          {search !== null && (
            <p className="modal__note">{summaryText(containersSummary(search))}</p>
          )}
          {search !== null && search.failures.length > 0 && (
            <p
              className="modal__note"
              title={search.failures.map((item) => `${item.target}: ${item.reason}`).join("\n")}
            >
              {ja.containment.containersFailures(search.failures.length)}
            </p>
          )}

          {rows.length > 0 && (
            <ul className="containers__list">
              {rows.map((row) => {
                const hint = hintText(row.view, row.label, false);
                const tip = tipOf(row.target);
                return (
                  <li key={row.target} className="containers__row" title={hint}>
                    <span className="containers__name">{row.label}</span>
                    <span className={`containment containment--tree containment--${row.view.mark}`}>
                      {markText(row.view)}
                    </span>
                    <span className="app__spacer" />
                    {tip !== null && (
                      <button
                        type="button"
                        className="button button--small"
                        onClick={() => {
                          onJumpCommit(tip);
                          close();
                        }}
                      >
                        {ja.containment.containersJumpBranch}
                      </button>
                    )}
                    {row.squash !== null && (
                      <button
                        type="button"
                        className="button button--small"
                        onClick={() => {
                          if (row.squash !== null) onJumpCommit(row.squash);
                          close();
                        }}
                      >
                        {ja.containment.containersJumpSquash(row.squash.slice(0, 8))}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="modal__actions">
          {running && (
            <button type="button" className="button" disabled={stopping} onClick={stop}>
              {ja.containment.containersStop}
            </button>
          )}
          <button type="button" className="button button--primary" onClick={close}>
            {ja.containment.close}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProgressLine({ progress, stopping }: { progress: Progress | null; stopping: boolean }) {
  if (stopping) return <p className="modal__note">{ja.containment.containersStopping}</p>;
  if (progress === null) return <p className="modal__note">{ja.containment.containersStarting}</p>;
  const view = containersProgressView(progress.done, progress.total, progress.elapsedMs);
  return (
    <p className="modal__note">
      {ja.containment.containersProgress(view.done, view.total, progress.found)}
      {view.remainingSeconds !== null && view.remainingSeconds > 0 && (
        <>{ja.containment.containersRemaining(view.remainingSeconds)}</>
      )}
    </p>
  );
}

function summaryText(summary: ContainersSummary): string {
  switch (summary.kind) {
    case "noCandidates":
      return ja.containment.containersNoCandidates;
    case "none":
      return ja.containment.containersNone(summary.checked);
    case "found":
      return ja.containment.containersFound(summary.count, summary.checked);
    case "cancelled":
      return ja.containment.containersCancelled(summary.count, summary.checked, summary.total);
  }
}
