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
import type { Blocker, CheckoutTarget, WriteGuard } from "../../lib/ipc";
import { mergeVerdict } from "../../lib/writeOps";
import type { WriteRequest } from "../../hooks/useWriteOps";
import { ConfirmDialog, ResultDialog, type ConfirmAction } from "./ConfirmDialog";

export function WriteOpsDialog({
  request,
  onCheckout,
  onMerge,
  onCancel,
}: {
  request: WriteRequest;
  onCheckout: (target: CheckoutTarget) => void;
  onMerge: (rev: string) => void;
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

function whyNot(why: "detached" | "unknown" | "ahead" | "upToDate", ahead: number): string {
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
