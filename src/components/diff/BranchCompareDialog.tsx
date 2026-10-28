/**
 * 「比べる…」のダイアログ（T-41。docs/DESIGN.md §10.3）。
 *
 * 比較元と比較先を ref の一覧から選び、**選んだ時点の SHA で** 2 点比較を始める。
 * 既定値・押せるか・一覧の並びは `lib/branchCompare.ts` の純関数で、ここは描くだけ。
 *
 * **比べ方は既定で「マージベース起点」**（`A...B`）。2 点間差分だと、比較元の側で
 * 進んだぶんが逆向きに混ざって「このブランチで何を変えたか」が読めない。
 * **この選択は残さない**（いまの 2 点比較と同じ。§10.3）。
 */
import { useState } from "react";

import { useEscape } from "../../hooks/useEscape";
import { ja } from "../../i18n/ja";
import {
  compareChoices,
  compareDefaults,
  compareReadiness,
  type CompareEnds,
  type CompareReadiness,
} from "../../lib/branchCompare";
import type { RefEntry } from "../../lib/ipc";

export function BranchCompareDialog({
  entry,
  refs,
  defaultBranch,
  headBranch,
  onStart,
  onClose,
}: {
  /** 右クリックされた ref。比較先に入れて開く。 */
  entry: RefEntry;
  refs: RefEntry[];
  defaultBranch: string | null;
  headBranch: string | null;
  /** SHA で渡す。`symmetric` は `A...B` で比べるか。 */
  onStart: (from: string, to: string, symmetric: boolean) => void;
  onClose: () => void;
}) {
  const [ends, setEnds] = useState<CompareEnds>(() =>
    compareDefaults(entry, refs, defaultBranch, headBranch),
  );
  const [symmetric, setSymmetric] = useState(true);
  useEscape(onClose);

  const readiness = compareReadiness(ends, refs);
  const why = whyText(readiness);

  const start = () => {
    if (readiness.kind !== "ready") return;
    onStart(readiness.from, readiness.to, symmetric);
    onClose();
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={ja.branchCompare.title}>
      <div className="modal__box modal__box--wide">
        <h2 className="modal__title">{ja.branchCompare.title}</h2>
        <p className="modal__lead">{ja.branchCompare.lead}</p>

        <div className="modal__body">
          <div className="bcmp__ends">
            <EndPicker
              label={ja.compare.from}
              kind="from"
              refs={refs}
              selected={ends.from}
              onSelect={(name) => setEnds((current) => ({ ...current, from: name }))}
            />
            <EndPicker
              label={ja.compare.to}
              kind="to"
              refs={refs}
              selected={ends.to}
              onSelect={(name) => setEnds((current) => ({ ...current, to: name }))}
            />
          </div>

          <div className="check">
            <label className="check__row">
              <input
                type="checkbox"
                checked={symmetric}
                onChange={(event) => setSymmetric(event.target.checked)}
              />
              {ja.compare.symmetric}
            </label>
            <p className="check__note">{ja.compare.symmetricHint}</p>
          </div>

          {/* **押せない理由を出す**（CLAUDE.md §6）。ボタンのツールチップだけだと気付けない。 */}
          {why !== null && <p className="modal__note">{why}</p>}
        </div>

        <div className="modal__actions">
          <button type="button" className="button" onClick={onClose}>
            {ja.branchCompare.cancel}
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={readiness.kind !== "ready"}
            title={why ?? undefined}
            onClick={start}
          >
            {ja.branchCompare.start}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 片方の端。絞り込みの欄と、種類ごとに分けた一覧。 */
function EndPicker({
  label,
  kind,
  refs,
  selected,
  onSelect,
}: {
  label: string;
  kind: "from" | "to";
  refs: RefEntry[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const choices = compareChoices(refs, filter, selected);
  const groups: { label: string; entries: RefEntry[] }[] = [
    { label: ja.branchCompare.groupLocal, entries: choices.filter((ref) => ref.kind === "localBranch") },
    { label: ja.branchCompare.groupRemote, entries: choices.filter((ref) => ref.kind === "remoteBranch") },
    { label: ja.branchCompare.groupTag, entries: choices.filter((ref) => ref.kind === "tag") },
  ].filter((group) => group.entries.length > 0);

  return (
    <div className="field bcmp__end">
      {/* 印は比較バーと同じ色にする（どちらの端か目で追えるように）。 */}
      <span className={`cmp__badge cmp__badge--${kind} bcmp__badge`}>{label}</span>
      <input
        className="input"
        type="search"
        placeholder={ja.branchCompare.filter}
        aria-label={`${label}: ${ja.branchCompare.filter}`}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <select
        className="bcmp__list"
        size={10}
        aria-label={label}
        value={selected ?? ""}
        onChange={(event) => onSelect(event.target.value)}
      >
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.entries.map((ref) => (
              <option key={ref.name} value={ref.name}>
                {ref.shortName}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {groups.length === 0 && <p className="modal__note">{ja.branchCompare.noMatch}</p>}
    </div>
  );
}

function whyText(readiness: CompareReadiness): string | null {
  switch (readiness.kind) {
    case "ready":
      return null;
    case "missing":
      return ja.branchCompare.whyMissing;
    case "sameRef":
      return ja.branchCompare.whySameRef;
    case "sameCommit":
      return ja.branchCompare.whySameCommit;
  }
}
