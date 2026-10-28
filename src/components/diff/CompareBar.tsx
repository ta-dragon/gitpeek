/**
 * 2 点比較のパネル（docs/DESIGN.md §10.3）。
 *
 * 比較中はコミット詳細の代わりにここを出す。**1 点のときの詳細と同じ場所**に置くのは、
 * 「今どちらを見ているか」が同じ位置で分かるようにするため。
 *
 * 両端を指している ref の名前と、片側にだけあるコミットの数も出す（T-41）。名前は
 * **いまその SHA を指しているもの**で、fetch で ref が動けば消える（`lib/branchCompare.ts`）。
 */
import { ja } from "../../i18n/ja";
import { refsAt, type CompareCounts } from "../../lib/branchCompare";
import type { CommitMeta, RefEntry } from "../../lib/ipc";

export function CompareBar({
  from,
  to,
  symmetric,
  refs,
  counts,
  onSymmetricChange,
  onSwap,
  onClear,
}: {
  /** 比較元。読み込んだ集合の外にあれば SHA だけ分かる。 */
  from: { sha: string; commit: CommitMeta | null };
  to: { sha: string; commit: CommitMeta | null };
  symmetric: boolean;
  refs: RefEntry[];
  counts: CompareCounts;
  onSymmetricChange: (symmetric: boolean) => void;
  onSwap: () => void;
  onClear: () => void;
}) {
  return (
    <section className="cmp">
      <header className="cmp__head">
        <h2 className="cmp__title">{ja.compare.title}</h2>
        <button type="button" className="button button--small" onClick={onSwap}>
          {ja.compare.swap}
        </button>
        <button type="button" className="button button--small" onClick={onClear}>
          {ja.compare.clear}
        </button>
      </header>

      <End label={ja.compare.from} end={from} names={refsAt(from.sha, refs)} kind="from" />
      <End label={ja.compare.to} end={to} names={refsAt(to.sha, refs)} kind="to" />

      <p className="cmp__counts">{countsText(counts)}</p>

      {/*
       * 比べ方は**この比較かぎり**の判断なので `settings.json` に残さない
       * （docs/DESIGN.md §10.3）。
       */}
      <label className="cmp__check" title={ja.compare.symmetricHint}>
        <input
          type="checkbox"
          checked={symmetric}
          onChange={(event) => onSymmetricChange(event.target.checked)}
        />
        {ja.compare.symmetric}
      </label>
    </section>
  );
}

function End({
  label,
  end,
  names,
  kind,
}: {
  label: string;
  end: { sha: string; commit: CommitMeta | null };
  /** その SHA を指している ref の短い名前。無ければ出さない。 */
  names: string[];
  kind: "from" | "to";
}) {
  const joined = names.join(", ");
  return (
    <div className="cmp__end">
      {/* 印はグラフ上の行と同じ色にする（どちらの端か目で追えるように）。 */}
      <span className={`cmp__badge cmp__badge--${kind}`}>{label}</span>
      <span className="cmp__sha">{end.sha.slice(0, 8)}</span>
      {names.length > 0 && (
        <span className="cmp__refs" title={joined}>
          {joined}
        </span>
      )}
      <span className="cmp__subject">{end.commit?.subject ?? ja.compare.outsideGraph}</span>
    </div>
  );
}

function countsText(counts: CompareCounts): string {
  if (counts.kind === "unknown") return ja.compare.countsUnknown;
  return `${ja.compare.onlyInTo(counts.onlyInTo)} / ${ja.compare.onlyInFrom(counts.onlyInFrom)}`;
}
