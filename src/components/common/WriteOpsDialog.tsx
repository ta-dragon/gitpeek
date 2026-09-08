/**
 * 確認と結果の文面を組み立てる（T-18。docs/DESIGN.md §8.1, §8.2）。
 *
 * `ConfirmDialog` は「止める理由 / 注意 / 選択肢」を並べるだけの器で、
 * **何をどう言うかを決めるのはここ**。文言そのものは `i18n/ja.ts`（CLAUDE.md §6）。
 *
 * **「走らせない理由」は 1 か所にまとめて出す。** 作業ツリーが汚れている（判定）のと
 * fast-forward できない（グラフ）のは出どころが違うが、利用者にとっては同じ
 * 「いま押せない理由」なので、分けて置くと読み落とす。
 */
import { ja } from "../../i18n/ja";
import type {
  Blocker,
  CheckoutTarget,
  FetchMergeOutcome,
  FetchProgress,
  WriteGuard,
} from "../../lib/ipc";
import {
  fetchMergeDetails,
  fetchMergeStage,
  mergeVerdict,
  type MergeBlockReason,
} from "../../lib/writeOps";
import type { FetchMergePhase, WriteRequest } from "../../hooks/useWriteOps";
import { ConfirmDialog, ResultDialog, type ConfirmAction } from "./ConfirmDialog";
import { LoadProgress } from "./LoadProgress";

export function WriteOpsDialog({
  request,
  onCheckout,
  onMerge,
  onFetchMerge,
  onCancel,
}: {
  request: WriteRequest;
  onCheckout: (target: CheckoutTarget) => void;
  onMerge: (rev: string) => void;
  /** 取ってきて取り込む（T-31）。**受け取るのは完全な ref 名。** */
  onFetchMerge: (rev: string) => void;
  onCancel: () => void;
}) {
  const blockers = request.guard.blockers.map((blocker) =>
    blockerText(blocker, request.guard),
  );

  if (request.op === "checkout") {
    const notes: string[] = [];
    for (const choice of request.choices) {
      if (choice.kind === "track" && choice.target.kind === "track") {
        notes.push(ja.writeOps.noteTrack(choice.target.branch, choice.target.remoteRef));
      }
      if (choice.kind === "detach") notes.push(ja.writeOps.noteDetach);
    }
    // **未追跡は止めていない**ので、注意として出す（docs/DESIGN.md §8.1）。
    if (request.guard.untracked > 0) {
      notes.push(ja.writeOps.noteUntracked(request.guard.untracked));
    }

    const actions: ConfirmAction[] = request.choices.map((choice) => ({
      label:
        choice.kind === "switch"
          ? ja.writeOps.actionSwitch(choice.name)
          : choice.kind === "track"
            ? ja.writeOps.actionTrack(choice.name)
            : ja.writeOps.actionDetach,
      primary: choice.primary,
      onSelect: () => onCheckout(choice.target),
    }));

    return (
      <ConfirmDialog
        title={ja.writeOps.checkoutTitle}
        lead={leadFor(request.subject)}
        blockers={blockers}
        notes={notes}
        actions={actions}
        onCancel={onCancel}
      />
    );
  }

  // 取ってきて取り込む（T-31。docs/DESIGN.md §8.6）。
  //
  // **取り込めるかどうかはここで決めない。** 取ってくると変わるので、
  // いまの値は注記として出すだけ。止める理由に入れるのは、
  // **取ってきても変わらないもの**（判定と detached）だけ。
  if (request.op === "fetchMerge") {
    const reasons =
      request.branch === null ? [...blockers, ja.writeOps.mergeDetached] : blockers;

    const notes: string[] = [
      request.check.known
        ? ja.writeOps.fetchMergeNow(request.check.ahead, request.check.behind)
        : ja.writeOps.fetchMergeNowUnknown,
      ja.writeOps.fetchMergeCancelNote,
    ];
    if (request.guard.untracked > 0) {
      notes.push(ja.writeOps.noteUntracked(request.guard.untracked));
    }

    return (
      <ConfirmDialog
        title={ja.writeOps.fetchMergeTitle}
        lead={ja.writeOps.fetchMergeLead(request.branch ?? "", request.revLabel)}
        help={ja.writeOps.fetchMergeHelp}
        blockers={reasons}
        notes={notes}
        actions={[
          {
            label: ja.writeOps.fetchMergeRun,
            primary: true,
            onSelect: () => onFetchMerge(request.rev),
          },
        ]}
        onCancel={onCancel}
      />
    );
  }

  const verdict = mergeVerdict(request.check, request.branch === null);
  // fast-forward できない理由も「走らせない理由」として同じ場所に出す。
  const reasons = verdict.can ? blockers : [...blockers, whyNot(verdict.why, request.check.ahead)];

  return (
    <ConfirmDialog
      title={ja.writeOps.mergeTitle}
      lead={
        verdict.can
          ? ja.writeOps.mergeLead(request.branch ?? "", request.revLabel, verdict.behind)
          : request.revLabel
      }
      // **取り込めないときも説明を出す。** 「できません」だけでは何ができないのか読めない。
      help={ja.writeOps.mergeHelp}
      blockers={reasons}
      actions={[
        {
          label: ja.writeOps.mergeRun,
          primary: true,
          onSelect: () => onMerge(request.rev),
        },
      ]}
      onCancel={onCancel}
    />
  );
}

/** 実行結果。**判定が変わって走らなかった場合は、その旨を出す。** */
export function WriteOpsResult({
  outcome,
  busy,
  onClose,
}: {
  outcome: { ok: boolean; message: string; details: string[]; refused: WriteGuard | null };
  busy: boolean;
  onClose: () => void;
}) {
  const refused = outcome.refused;
  const message =
    refused === null
      ? outcome.message
      : [ja.writeOps.refused, ...refused.blockers.map((b) => blockerText(b, refused))].join(" ");

  return (
    <ResultDialog
      ok={outcome.ok}
      message={message}
      details={outcome.details}
      busy={busy}
      onClose={onClose}
    />
  );
}

function leadFor(subject: { kind: string; name: string }): string {
  switch (subject.kind) {
    case "branch":
      return ja.writeOps.leadBranch(subject.name);
    case "remote":
      return ja.writeOps.leadRemote(subject.name);
    case "tag":
      return ja.writeOps.leadTag(subject.name);
    default:
      return ja.writeOps.leadCommit(subject.name);
  }
}

function blockerText(blocker: Blocker, guard: WriteGuard): string {
  switch (blocker) {
    case "bare":
      return ja.writeOps.blockerBare;
    case "dirty":
      return ja.writeOps.blockerDirty(guard.changed);
    case "indexLock":
      return ja.writeOps.blockerIndexLock;
    case "unborn":
      return ja.writeOps.blockerUnborn;
  }
}

function whyNot(why: MergeBlockReason, ahead: number): string {
  switch (why) {
    case "detached":
      return ja.writeOps.mergeDetached;
    case "unknown":
      return ja.writeOps.mergeUnknown;
    case "upToDate":
      return ja.writeOps.mergeUpToDate;
    case "ahead":
      return ja.writeOps.mergeAhead(ahead);
  }
}

/**
 * 「取ってきて取り込む」の実行中（T-31。docs/DESIGN.md §8.6）。
 *
 * **中止ボタンは取ってくる間しか出さない。** `merge --ff-only` は止められないので、
 * 押せるボタンを残すと「押したのに止まらない」ことになる。段が変わったことは
 * Rust 側からのイベントで届く。
 */
export function FetchMergeProgress({
  phase,
  progress,
  cancelling,
  onCancel,
}: {
  phase: FetchMergePhase;
  progress: FetchProgress | null;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const fetching = phase === "fetching";

  return (
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label={ja.writeOps.fetchMergeTitle}
    >
      <div className="modal__box modal__box--wide">
        <h2 className="modal__title">
          {fetching ? ja.writeOps.fetchMergeFetching : ja.writeOps.fetchMergeMerging}
        </h2>

        {fetching ? (
          <LoadProgress
            // git の見出しをそのまま出す。**翻訳されていることがある。**
            label={progress?.label ?? ja.writeOps.fetchMergeFetching}
            done={progress?.done ?? 0}
            total={progress?.total ?? null}
            estimated={false}
            elapsedMs={progress?.elapsedMs ?? 0}
          />
        ) : (
          // **止められないことを黙っていない。**
          <p className="modal__note">{ja.writeOps.fetchMergeNoCancel}</p>
        )}

        <div className="modal__actions">
          <button
            type="button"
            className="button"
            onClick={onCancel}
            disabled={!fetching || cancelling}
          >
            {cancelling ? ja.writeOps.fetchMergeCancelling : ja.writeOps.fetchMergeCancel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 「取ってきて取り込む」の結果（T-31）。
 *
 * **どこまで進んだかを最初の 1 行で言う。** 「取ってきたが取り込まなかった」と
 * 「取ってこられなかった」は別の話なので、同じ文言にまとめない。
 * どの段で止まったかの判定は `lib/writeOps.ts` の `fetchMergeStage`（CLAUDE.md §8）。
 */
export function FetchMergeResult({
  outcome,
  onClose,
}: {
  outcome: FetchMergeOutcome;
  onClose: () => void;
}) {
  const stage = fetchMergeStage(outcome);
  const lines: string[] = [];

  switch (stage.stage) {
    case "refused":
      lines.push(ja.writeOps.refused);
      if (outcome.refused !== null) {
        const guard = outcome.refused;
        lines.push(...guard.blockers.map((blocker) => blockerText(blocker, guard)));
      }
      break;
    case "fetchStopped":
      lines.push(
        stage.status === "cancelled"
          ? ja.writeOps.fetchMergeFetchCancelled
          : ja.writeOps.fetchMergeFetchFailed,
      );
      if (outcome.fetch !== null) lines.push(outcome.fetch.message);
      break;
    case "notMerged":
      lines.push(ja.writeOps.fetchMergeNotMerged);
      if (outcome.fetch !== null) lines.push(outcome.fetch.message);
      lines.push(whyNot(stage.why, outcome.check?.ahead ?? 0));
      break;
    case "merged":
      if (stage.ok) {
        lines.push(ja.writeOps.fetchMergeMerged);
        if (outcome.fetch !== null) lines.push(outcome.fetch.message);
      } else {
        lines.push(ja.writeOps.fetchMergeMergeFailed);
        if (outcome.merge !== null) lines.push(outcome.merge.message);
      }
      break;
  }

  return (
    <ResultDialog
      ok={stage.stage === "merged" && stage.ok}
      message={lines.join(" ")}
      details={fetchMergeDetails(outcome)}
      busy={false}
      onClose={onClose}
    />
  );
}
