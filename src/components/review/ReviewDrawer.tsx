/**
 * AI レビューのドロワー（T-23。DESIGN.md §6.1）。
 *
 * **開いている間はコミット情報の列を畳む。** 3 列 ＋ ドロワーでは差分が潰れる
 * （§6.1 が T-23 送りにしていた件）。ドロワーは指摘から差分へ飛べるので、
 * 閉じている間の変更ファイル一覧の役目をそのまま引き取れる。
 *
 * 中身は **実行前 / 実行中 / 結果 / 履歴** の 4 つ。行き来はこの中で完結させる
 * （モーダルにすると、差分を見ながら外すファイルを決められない）。
 */
import { save } from "@tauri-apps/plugin-dialog";

import { ja } from "../../i18n/ja";
import { exportMarkdown } from "../../lib/ipc";
import type { LlmProfile } from "../../lib/ipc";
import { markdownFileName, toMarkdown } from "../../lib/reviewMarkdown";
import type { LineLookup } from "../../lib/reviewFindings";
import type { TargetContext } from "../../lib/reviewTarget";
import type { ReviewState, ReviewView } from "../../hooks/useReview";
import { PreflightPanel } from "./PreflightPanel";
import { ReviewHistory } from "./ReviewHistory";
import { ReviewResult, RunningList } from "./ReviewResult";

export function ReviewDrawer({
  state,
  profiles,
  profileId,
  selected,
  reviewsDir,
  context,
  lookup,
  onProfileChange,
  onSelectedChange,
  onRun,
  onCancel,
  onShow,
  onOpenHistory,
  onJump,
  onClose,
  onNotice,
}: {
  state: ReviewState;
  profiles: LlmProfile[];
  profileId: string | null;
  selected: string[];
  reviewsDir: string | null;
  /** どのリポジトリの何を見たのか（`lib/reviewTarget.ts`）。結果・履歴・書き出しで同じ文言を使う。 */
  context: TargetContext;
  /** いま差分ペインに出ているファイルの行。**当たらなかった指摘を明記する**ため。 */
  lookup: LineLookup;
  onProfileChange: (id: string | null) => void;
  onSelectedChange: (paths: string[]) => void;
  onRun: () => void;
  onCancel: () => void;
  onShow: (view: ReviewView) => void;
  onOpenHistory: (file: string) => void;
  /** 指摘から差分へ飛ぶ。**行が無い（ファイル全体への）指摘では `line` が `null`。** */
  onJump: ((path: string, line: number | null) => void) | null;
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const saveMarkdown = async () => {
    if (state.stored === null) return;
    const path = await save({
      title: ja.review.markdown.saveTitle,
      defaultPath: markdownFileName(state.stored),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (path === null) return;
    await exportMarkdown(path, toMarkdown(state.stored, context));
    onNotice(ja.review.exported(path));
  };

  return (
    <div className="review" aria-label={ja.review.title}>
      <div className="review__head">
        <h2 className="review__title">{ja.review.title}</h2>
        <div className="review__tabs">
          <button
            type="button"
            className={tabClass(state.view === "preflight")}
            onClick={() => onShow("preflight")}
          >
            {ja.review.run}
          </button>
          <button
            type="button"
            className={tabClass(state.view === "history")}
            onClick={() => onShow("history")}
          >
            {ja.review.historyTab}
          </button>
          <button type="button" className="button button--small" onClick={onClose}>
            {ja.review.close}
          </button>
        </div>
      </div>

      {state.view === "preflight" && (
        <PreflightPanel
          plan={state.plan}
          planError={state.planError}
          loading={state.loadingPlan}
          profiles={profiles}
          profileId={profileId}
          selected={selected}
          running={state.running}
          onProfileChange={onProfileChange}
          onSelectedChange={onSelectedChange}
          onRun={onRun}
        />
      )}

      {state.view === "running" && (
        <>
          <div className="review__actions">
            <button
              type="button"
              className="button"
              disabled={state.cancelling}
              onClick={onCancel}
            >
              {state.cancelling ? ja.review.cancelling : ja.review.cancel}
            </button>
          </div>
          <RunningList progress={state.progress} summaryStreamed={state.summaryStreamed} />
        </>
      )}

      {state.view === "result" && (
        <>
          <div className="review__actions">
            <button type="button" className="button" onClick={() => onShow("preflight")}>
              {ja.review.rerun}
            </button>
            <button
              type="button"
              className="button"
              // 結果が無いときも**消さずに**押せない形で残す。
              disabled={state.stored === null}
              onClick={() => void saveMarkdown()}
            >
              {ja.review.exportMarkdown}
            </button>
          </div>
          <ReviewResult
            stored={state.stored}
            runError={state.runError}
            context={context}
            lookup={lookup}
            onJump={onJump}
          />
        </>
      )}

      {state.view === "history" && (
        <ReviewHistory
          rows={state.history}
          error={state.historyError}
          where={reviewsDir}
          context={context}
          onOpen={onOpenHistory}
        />
      )}
    </div>
  );
}

function tabClass(active: boolean): string {
  return active ? "button button--small button--primary" : "button button--small";
}
