/**
 * レビュー観点（skill）の一覧（T-21）。
 *
 * **2 つの画面が同じ部品を使う。**
 *
 * - アプリ全体の「設定」… 内蔵とグローバル（自分で置いたもの）
 * - リポジトリの右クリック →「このリポジトリの設定」… そのリポジトリの中のもの
 *
 * 分けたのは、**リポジトリに紐づくものをアプリ全体の設定に置くと、どのリポジトリの
 * 話をしているのか読めなくなる**ため（2026-09-05 に利用者の指摘）。
 *
 * ここが守っていること:
 *
 * - **判定を書かない。** 出し分けは `lib/skillTrust.ts` の純関数が決める（CLAUDE.md §8）
 * - **効かない skill を一覧から消さない。** 効かない理由を必ず添える（CLAUDE.md §6）
 * - **読ませずに使わせない。** 決めていない／変わったものは本文を開いた状態で出す
 * - ここに出る本文は `preview`。**プロンプトへ渡る本文はフロントに来ない**
 */
import { useEffect, useState } from "react";

import { ja } from "../../i18n/ja";
import {
  setSkillExtra,
  setSkillUse,
  type SkillCatalog,
  type SkillEntry,
  type SkillOrigin,
} from "../../lib/ipc";
import {
  countSkills,
  extraChanged,
  skillDisplay,
  targetOf,
  useAction,
  type UseAction,
} from "../../lib/skillTrust";

export function SkillList({
  entries,
  repositoryId,
  emptyNote,
  onChanged,
  onFailed,
}: {
  entries: SkillEntry[];
  /** リポジトリ内 skill を指すのに要る。内蔵・グローバルだけなら null。 */
  repositoryId: string | null;
  /** 1 件も無いときの 1 行。**画面ごとに言うことが違う。** */
  emptyNote: string;
  onChanged: (catalog: SkillCatalog) => void;
  onFailed: (message: string) => void;
}) {
  const counts = countSkills(entries);

  if (entries.length === 0) {
    return <p className="modal__note">{emptyNote}</p>;
  }

  return (
    <>
      <p className="modal__note">
        {ja.skills.counts(counts.inUse)}
        {counts.undecided > 0 && ` / ${ja.skills.countsUndecided(counts.undecided)}`}
        {counts.changed > 0 && ` / ${ja.skills.countsChanged(counts.changed)}`}
        {counts.unreadable > 0 && ` / ${ja.skills.countsUnreadable(counts.unreadable)}`}
      </p>
      <ul className="skills">
        {entries.map((entry) => (
          <SkillRow
            key={`${entry.origin}:${entry.file}:${entry.name}`}
            entry={entry}
            repositoryId={repositoryId}
            onChanged={onChanged}
            onFailed={onFailed}
          />
        ))}
      </ul>
    </>
  );
}

function SkillRow({
  entry,
  repositoryId,
  onChanged,
  onFailed,
}: {
  entry: SkillEntry;
  repositoryId: string | null;
  onChanged: (catalog: SkillCatalog) => void;
  onFailed: (message: string) => void;
}) {
  const display = skillDisplay(entry);
  const action = useAction(entry);
  const target = targetOf(entry, repositoryId);
  const [busy, setBusy] = useState(false);
  const [extra, setExtra] = useState(entry.extra);

  // 保存のたびに一覧を作り直すので、外から来た値に合わせ直す。
  useEffect(() => setExtra(entry.extra), [entry.extra]);

  const run = async (call: () => Promise<SkillCatalog>) => {
    setBusy(true);
    try {
      onChanged(await call());
    } catch (error) {
      onFailed(typeof error === "string" ? error : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`skills__row${display.effective ? "" : " skills__row--held"}`}>
      <span className="skills__name">{entry.name}</span>
      <span className="badge">{originLabel(entry.origin)}</span>
      <span className="badge">{stateLabel(entry)}</span>
      <span className="skills__description">{entry.description}</span>

      {/* いつ効くのかを 1 行で。**glob をそのまま出しても伝わらない**ので言い換える。 */}
      <span className="skills__when">
        {entry.globs.length === 0
          ? ja.skills.always
          : ja.skills.onlyWhen(entry.globs.join(" / "))}
      </span>

      {/* **効かない理由は必ず出す。** */}
      {display.reason !== null && <span className="skills__reason">{display.reason}</span>}
      {display.shadowedBy !== null && (
        <span className="skills__reason">
          {ja.skills.shadowed(originLabel(display.shadowedBy))}
        </span>
      )}
      {display.state === "untrusted" && (
        <span className="skills__reason">{ja.skills.stateNote.untrusted}</span>
      )}
      {display.state === "recheck" && (
        <span className="skills__reason">{ja.skills.stateNote.recheck}</span>
      )}

      {/* **決める前に読ませる。** 未決・変更ありのものは開いた状態で出す。 */}
      {display.reason === null && (
        <details className="skills__body" open={display.mustRead}>
          <summary>{ja.skills.readBody}</summary>
          <pre className="llmRaw">{entry.preview}</pre>
        </details>
      )}

      <span className="skills__actions">
        <button
          type="button"
          className={`button button--small${action.next ? " button--primary" : ""}`}
          disabled={!action.enabled || busy || target === null}
          onClick={() =>
            void run(() =>
              setSkillUse(target!, action.next, entry.hash === "" ? null : entry.hash),
            )
          }
        >
          {action.next ? ja.skills.use : ja.skills.stop}
        </button>
      </span>
      {/* **押せない理由といまの値を出す**（CLAUDE.md §6）。 */}
      <span className="skills__when">{actionNote(action, display.decidedByUser, entry)}</span>

      {/* 追加の指示。**skill ファイルは書き換えない**ので、他人のリポジトリのものにも足せる。 */}
      <label className="skills__extra">
        <span className="field__label">{ja.skills.extraLabel}</span>
        <textarea
          className="input skills__extraInput"
          value={extra}
          rows={2}
          placeholder={ja.skills.extraPlaceholder}
          disabled={busy || target === null}
          onChange={(event) => setExtra(event.target.value)}
          onBlur={() => {
            // **中身が変わったときだけ書く。** 手編集する settings.json を
            // 欄から離れるたびに上書きしない。
            if (target === null || !extraChanged(entry.extra, extra)) return;
            void run(() => setSkillExtra(target, extra));
          }}
        />
      </label>
      <span className="skills__when">{ja.skills.extraNote}</span>
    </li>
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

function stateLabel(entry: SkillEntry): string {
  switch (entry.state.kind) {
    case "ready":
      return entry.inUse ? ja.skills.stateReady : ja.skills.stateOff;
    case "untrusted":
      return ja.skills.stateUndecided;
    case "recheck":
      return ja.skills.stateChanged;
    case "unreadable":
      return ja.skills.stateUnreadable;
  }
}

/** ボタンの下の 1 行。**押せない理由と、いまの値がどこから来たかを出す。** */
function actionNote(action: UseAction, decidedByUser: boolean, entry: SkillEntry): string {
  switch (action.kind) {
    case "unreadable":
      return ja.skills.actionNote.unreadable;
    case "shadowed":
      return ja.skills.actionNote.shadowed;
    case "use":
      return entry.origin === "repository"
        ? ja.skills.actionNote.useRepository
        : ja.skills.actionNote.use;
    case "stop":
      return decidedByUser
        ? ja.skills.actionNote.stop
        : ja.skills.actionNote.stopFileDefault;
  }
}
