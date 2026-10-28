/**
 * ref の右クリックメニューのうち、**2 か所で同じものを出す項目**（T-31）。
 *
 * ref のメニューは ref ツリー（`sidebar/RefTree.tsx`）とグラフのチップ
 * （`commits/CommitList.tsx`）の 2 か所にある。**片方だけにあると、どこから
 * 辿れるのか読めない。** 既存の「取り込む」は両方に手で書いてあり、
 * 実際に文言が食い違いかけたので、新しい項目はここ 1 か所から配る。
 *
 * **押せるかどうかの判定は `lib/repositoryMenu.ts` の純関数**（CLAUDE.md §8）。
 * ここがするのは、その結果を文言へ引き当てることだけ（文言は `i18n/ja.ts`）。
 */
import { ja } from "../../i18n/ja";
import type { RefEntry } from "../../lib/ipc";
import { canFetchMerge } from "../../lib/repositoryMenu";
import { openBranchCompare } from "../../store/branchCompare";
import type { ContextMenuItem } from "./ContextMenu";

/**
 * 「取ってきて取り込む」（T-31。docs/DESIGN.md §8.6）。
 *
 * **押せなくても消さない。** 押せない理由をツールチップに出す（CLAUDE.md §6）。
 */
export function fetchMergeItem(
  entry: RefEntry,
  /** HEAD が乗っているローカルブランチの短い名前。detached なら null。 */
  headBranch: string | null,
  onSelect: (entry: RefEntry) => void,
): ContextMenuItem {
  const availability = canFetchMerge(entry.kind, headBranch);

  return {
    // **方向を名前で書く**（CLAUDE.md §6）。detached では先が無いので言い切らない。
    label:
      headBranch === null
        ? ja.refTree.fetchMerge
        : ja.refTree.fetchMergeInto(headBranch, entry.shortName),
    disabled: !availability.enabled,
    title: reasonText(availability.why),
    onSelect: () => onSelect(entry),
  };
}

/**
 * 「比べる…」（T-41。docs/DESIGN.md §10.3）。押すと比較元と比較先を選ぶダイアログが開く。
 *
 * **ここでは押せるかを判定しない。** 同じもの同士かどうかは、両端が決まるダイアログの中で
 * `compareReadiness` が見る（タグもグラフの外の ref も比べられる — 差分は SHA で取る）。
 */
export function compareItem(entry: RefEntry): ContextMenuItem {
  return {
    label: ja.branchCompare.menu,
    title: ja.branchCompare.menuHint,
    onSelect: () => openBranchCompare(entry),
  };
}

function reasonText(why: "detached" | "localBranch" | null): string {
  switch (why) {
    case "detached":
      return ja.refTree.fetchMergeDetached;
    case "localBranch":
      return ja.refTree.fetchMergeLocal;
    // 押せるときは、何が起きるかを出す。
    case null:
      return ja.refTree.fetchMergeHint;
  }
}
