/**
 * レビュー観点（skill）の一覧と信頼操作（T-21）。**設定モーダルのタブ 1 つ。**
 *
 * ここが守っていること:
 *
 * - **判定を書かない。** 出し分けは `lib/skillTrust.ts` の純関数が決める（CLAUDE.md §8）
 * - **効かない skill を一覧から消さない。** 効かない理由を必ず添える（CLAUDE.md §6）
 * - **読ませずに信頼させない。** 「使う」を押す前に全文を見せる（DESIGN.md §11.2）
 * - ここに出る本文は `preview`。**プロンプトへ渡る本文はフロントに来ない**
 *   （Rust 側の `SkillEntry::usable_body` にしか無い）
 */
import { useState } from "react";

import { ja } from "../../i18n/ja";
import {
  setRepoSkillTrust,
  type RepoTrustStatus,
  type SkillCatalog,
  type SkillEntry,
  type SkillOrigin,
} from "../../lib/ipc";
import {
  countSkills,
  skillDisplay,
  skillsToReview,
  trustOption,
  type TrustOption,
} from "../../lib/skillTrust";

export function RepoSkills({
  catalog,
  repositoryId,
  globalDir,
  onChanged,
  onFailed,
}: {
  catalog: SkillCatalog | null;
  /** 開いているリポジトリ。無ければ null（リポジトリ内は読まない）。 */
  repositoryId: string | null;
  /** グローバル skill の置き場所。文言に出す。 */
  globalDir: string;
  onChanged: (catalog: SkillCatalog) => void;
  onFailed: (message: string) => void;
}) {
  /** `trust` は信頼の確認画面、`untrust` は取り消しの確認。 */
  const [confirming, setConfirming] = useState<"trust" | "untrust" | null>(null);
  const [busy, setBusy] = useState(false);

  if (catalog === null) {
    return <p className="modal__note">{ja.skills.lead}</p>;
  }

  const option = trustOption(catalog.trust, repositoryId !== null);
  const counts = countSkills(catalog.entries);
  const held = counts.untrusted + counts.recheck;

  const apply = async (trusted: boolean) => {
    if (repositoryId === null) return;
    setBusy(true);
    try {
      onChanged(await setRepoSkillTrust(repositoryId, trusted));
      setConfirming(null);
    } catch (error) {
      onFailed(typeof error === "string" ? error : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (confirming === "trust") {
    return (
      <TrustReview
        entries={skillsToReview(catalog.entries)}
        status={catalog.trust}
        busy={busy}
        onAccept={() => void apply(true)}
        onCancel={() => setConfirming(null)}
      />
    );
  }

  return (
    <>
      <p className="modal__lead">{ja.skills.lead}</p>
      <p className="modal__note">
        {ja.skills.counts(counts.usable)}
        {held > 0 && ` / ${ja.skills.countsHeld(held)}`}
        {counts.unreadable > 0 && ` / ${ja.skills.countsUnreadable(counts.unreadable)}`}
      </p>

      {/* **なぜ既定で使わないのかを先に書く。** 手間の理由が読めないと、
          「とりあえず押す」ボタンになる。 */}
      <p className="modal__note">{ja.skills.trustWhy}</p>

      <div className="llmEditor__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!option.canTrust || busy}
          onClick={() => setConfirming("trust")}
        >
          {ja.skills.trust}
        </button>
        <button
          type="button"
          className="button"
          disabled={!option.canUntrust || busy}
          onClick={() => setConfirming("untrust")}
        >
          {ja.skills.untrust}
        </button>
      </div>
      {/* **押せない理由を必ず出す。** ボタンを消さない代わりにここで説明する。 */}
      <p className="modal__note">{trustNote(option)}</p>

      {confirming === "untrust" && (
        <div className="skills__confirm">
          <span>{ja.skills.untrustConfirm}</span>
          <button
            type="button"
            className="button button--small"
            onClick={() => setConfirming(null)}
          >
            {ja.skills.reviewCancel}
          </button>
          <button
            type="button"
            className="button button--small button--primary"
            disabled={busy}
            onClick={() => void apply(false)}
          >
            {ja.skills.untrust}
          </button>
        </div>
      )}

      {catalog.entries.length === 0 ? (
        <p className="modal__note">{ja.skills.empty}</p>
      ) : (
        <ul className="skills">
          {catalog.entries.map((entry) => (
            <SkillRow
              key={`${entry.origin}:${entry.file}:${entry.name}`}
              entry={entry}
              globalDir={globalDir}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function SkillRow({ entry, globalDir }: { entry: SkillEntry; globalDir: string }) {
  const display = skillDisplay(entry);
  return (
    <li className={`skills__row${display.effective ? "" : " skills__row--held"}`}>
      <span className="skills__name">{entry.name}</span>
      <span className="badge">{originLabel(entry.origin)}</span>
      <span className="badge">{stateLabel(entry)}</span>
      <span className="skills__description">{entry.description}</span>

      {/* いつ効くのかを 1 行で。**glob をそのまま出しても伝わらない**ので言い換える。 */}
      <span className="skills__when">
        {!entry.enabled
          ? ja.skills.offByDefault
          : entry.globs.length === 0
            ? ja.skills.always
            : ja.skills.onlyWhen(entry.globs.join(" / "))}
      </span>

      {/* **効かない理由は必ず出す。** */}
      {display.state === "untrusted" && (
        <span className="skills__reason">{ja.skills.stateNote.untrusted}</span>
      )}
      {display.state === "recheck" && (
        <span className="skills__reason">{ja.skills.stateNote.recheck}</span>
      )}
      {display.reason !== null && <span className="skills__reason">{display.reason}</span>}
      {display.shadowedBy !== null && (
        <span className="skills__reason">
          {ja.skills.shadowed(originLabel(display.shadowedBy))}
        </span>
      )}

      <span className="skills__where">{originNote(entry.origin, globalDir)}</span>
    </li>
  );
}

/** 信頼の確認画面。**全文を見せてから決めさせる。** */
function TrustReview({
  entries,
  status,
  busy,
  onAccept,
  onCancel,
}: {
  entries: SkillEntry[];
  status: RepoTrustStatus;
  busy: boolean;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const unreadable = entries.filter((entry) => entry.state.kind === "unreadable");
  return (
    <>
      <h3 className="modal__title">{ja.skills.reviewTitle}</h3>
      <p className="modal__lead">{ja.skills.reviewLead}</p>

      {/* **増えたほうを先に出す。** 信頼させたあとに置かれたファイルのほうが危ない。 */}
      {status.added.length > 0 && (
        <p className="modal__blocker">{ja.skills.reviewAdded(status.added.join(", "))}</p>
      )}
      {status.changed.length > 0 && (
        <p className="modal__blocker">
          {ja.skills.reviewChanged(status.changed.join(", "))}
        </p>
      )}
      {unreadable.length > 0 && (
        <p className="modal__note">{ja.skills.reviewUnreadableNote}</p>
      )}

      <ul className="skills">
        {entries.map((entry) => (
          <li className="skills__row" key={entry.file}>
            <span className="skills__name">{entry.file}</span>
            <span className="badge">{stateLabel(entry)}</span>
            <span className="skills__description">{entry.description}</span>
            {entry.state.kind === "unreadable" ? (
              <span className="skills__reason">{entry.state.reason}</span>
            ) : (
              // **全文をそのまま出す。** 折りたたむと読まずに押される。
              <pre className="llmRaw">{entry.preview}</pre>
            )}
          </li>
        ))}
      </ul>

      <div className="llmEditor__actions">
        <button type="button" className="button" onClick={onCancel}>
          {ja.skills.reviewCancel}
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={busy}
          onClick={onAccept}
        >
          {ja.skills.reviewAccept}
        </button>
      </div>
    </>
  );
}

function originLabel(origin: SkillOrigin): string {
  switch (origin) {
    case "builtIn":
      return ja.skills.originBuiltIn;
    case "global":
      return ja.skills.originGlobal;
    case "repository":
      return ja.skills.originRepository;
  }
}

function originNote(origin: SkillOrigin, globalDir: string): string {
  switch (origin) {
    case "builtIn":
      return ja.skills.originNote.builtIn;
    case "global":
      return ja.skills.originNote.global(globalDir);
    case "repository":
      return ja.skills.originNote.repository;
  }
}

function stateLabel(entry: SkillEntry): string {
  switch (entry.state.kind) {
    case "ready":
      return ja.skills.stateReady;
    case "untrusted":
      return ja.skills.stateUntrusted;
    case "recheck":
      return ja.skills.stateRecheck;
    case "unreadable":
      return ja.skills.stateUnreadable;
  }
}

function trustNote(option: TrustOption): string {
  return ja.skills.trustNote[option.kind];
}
