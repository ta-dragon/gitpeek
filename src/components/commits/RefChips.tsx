/**
 * コミットに乗っている ref のチップ（docs/DESIGN.md §6.3）。
 *
 * 行に収まらない場合は `+N` に畳み、ホバーで全件を出す。畳む判断は**幅の実測ではなく
 * 件数**で行う。実測すると行ごとにレイアウトが発生し、仮想スクロールが目に見えて重くなる。
 */
import { ja } from "../../i18n/ja";
import type { RefEntry } from "../../lib/ipc";

/** 1 行に出すチップの上限。これを超えたぶんは `+N` に畳む。 */
export const MAX_CHIPS = 3;

export function RefChips({
  refs,
  headBranch,
  detachedHead,
}: {
  refs: RefEntry[];
  /** HEAD が指しているローカルブランチの完全な ref 名。detached なら null。 */
  headBranch: string | null;
  /** この行が detached HEAD の位置か。 */
  detachedHead: boolean;
}) {
  if (refs.length === 0 && !detachedHead) return null;

  const shown = refs.slice(0, MAX_CHIPS);
  const hidden = refs.length - shown.length;

  return (
    <span className="chips">
      {detachedHead && <span className="chip chip--head">{ja.commits.detachedHead}</span>}
      {shown.map((entry) => (
        <span
          key={entry.name}
          className={`chip chip--${kindClass(entry.kind)}${entry.name === headBranch ? " chip--head" : ""}`}
          title={entry.name}
        >
          {entry.shortName}
        </span>
      ))}
      {hidden > 0 && (
        <span
          className="chip chip--more"
          title={refs
            .slice(MAX_CHIPS)
            .map((entry) => entry.shortName)
            .join("\n")}
        >
          {ja.commits.moreRefs(hidden)}
        </span>
      )}
    </span>
  );
}

function kindClass(kind: RefEntry["kind"]): string {
  switch (kind) {
    case "localBranch":
      return "local";
    case "remoteBranch":
      return "remote";
    case "tag":
      return "tag";
  }
}

/**
 * ref を指すコミットごとにまとめる。
 *
 * 並びは ローカル → リモート → タグ。同じ行に何本も乗るとき、どれが手元の
 * ブランチかを最初に見せたい。**グラフ外の ref は除く**（指す行が無い）。
 */
export function groupRefsBySha(refs: RefEntry[]): Map<string, RefEntry[]> {
  const order = { localBranch: 0, remoteBranch: 1, tag: 2 } as const;
  const grouped = new Map<string, RefEntry[]>();

  for (const entry of refs) {
    if (entry.outOfGraph) continue;
    const list = grouped.get(entry.target);
    if (list === undefined) grouped.set(entry.target, [entry]);
    else list.push(entry);
  }

  for (const list of grouped.values()) {
    list.sort((a, b) => order[a.kind] - order[b.kind] || a.shortName.localeCompare(b.shortName));
  }
  return grouped;
}
