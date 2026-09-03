/**
 * コミット選択と 2 点比較の状態遷移（純関数。docs/DESIGN.md §10.3）。
 *
 * **選択そのものは `state.json` の `selectedCommit` / `compareCommit` が正。**
 * ここにあるのは「クリックで次はどうなるか」だけで、保存も取得もしない。
 */

/** 選択の状態。`compareCommit` が入っていれば 2 点比較中で、そちらが**比較元**。 */
export type CommitSelection = {
  selectedCommit: string | null;
  compareCommit: string | null;
};

/**
 * コミットをクリックしたときの次の状態。`compare` は `Ctrl`（Mac は `Cmd`）。
 *
 * `Ctrl+クリック` は「**今の選択を比較元へ押し出して、押した先を比較先にする**」。
 * `A` を選んでから `B` を `Ctrl+クリック` すれば「A から B への差分」になる。
 * **比較中は比較元を動かさない** — 起点を固定したまま比較先だけ付け替えたいため。
 *
 * 普通のクリックは**比較を解除する**。比較したまま 3 点目を選べる意味は無い。
 */
export function selectCommit(
  current: CommitSelection,
  sha: string,
  compare: boolean,
): CommitSelection {
  if (!compare) return { selectedCommit: sha, compareCommit: null };

  const from = current.compareCommit ?? current.selectedCommit;

  // 何も選んでいないときの Ctrl+クリックは、ただの選択。
  // **自分自身との比較にもしない** — 差分が空になるだけで、比較の見た目だけが残る。
  if (from === null || from === sha) return { selectedCommit: sha, compareCommit: null };

  return { selectedCommit: sha, compareCommit: from };
}

/** 比較元と比較先を入れ替える。比較していなければ何もしない。 */
export function swapEnds(current: CommitSelection): CommitSelection {
  if (current.compareCommit === null) return current;
  return { selectedCommit: current.compareCommit, compareCommit: current.selectedCommit };
}

/** 比較をやめて 1 点選択へ戻る。 */
export function clearCompare(current: CommitSelection): CommitSelection {
  return { ...current, compareCommit: null };
}
