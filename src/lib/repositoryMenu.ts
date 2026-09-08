/**
 * リポジトリの右クリックメニューの出し分け（T-30）。
 *
 * **押せない項目も消さない。** 押せる条件でだけ出すと、条件が成立しない場面で
 * 選択肢そのものが画面から消え、何が効いているのか読めなくなる（CLAUDE.md §6）。
 * 押せない形で残し、**理由を `reason` で返す**。
 *
 * 判定を `.tsx` に直書きするとテストが 1 つも当たらない（CLAUDE.md §8）。
 */
import type { RefEntry, RepositoryEntry } from "./ipc";

/** 押せるかどうかと、押せないときの理由。 */
export type MenuAvailability = {
  enabled: boolean;
  /** 押せないときだけ入る。ツールチップに出す。 */
  reason: string | null;
};

const OK: MenuAvailability = { enabled: true, reason: null };

function find(entries: RepositoryEntry[], id: string): RepositoryEntry | null {
  return entries.find((entry) => entry.id === id) ?? null;
}

/**
 * fetch できるか。
 *
 * リモートが 1 つも無いリポジトリでは、押せても何も起きない。
 * **登録が消えている場合と、リモートが無い場合を言い分ける。**
 */
export function canFetch(
  entries: RepositoryEntry[],
  id: string,
  busy: boolean,
): MenuAvailability {
  const entry = find(entries, id);
  if (entry === null) return { enabled: false, reason: "この登録は見つかりません。" };
  if (busy) return { enabled: false, reason: "ほかの処理が動いています。" };
  if ((entry.probe?.remotes.length ?? 0) === 0) {
    return { enabled: false, reason: "リモートが登録されていないので取得先がありません。" };
  }
  return OK;
}

/**
 * フォルダをエクスプローラーで開けるか。
 *
 * `probe` が `null` なのは、登録したあとフォルダが移動・削除されたとき。
 * **Rust 側でも開く直前に実在を確かめる**が、分かっているなら押させない。
 */
export function canReveal(entries: RepositoryEntry[], id: string): MenuAvailability {
  const entry = find(entries, id);
  if (entry === null) return { enabled: false, reason: "この登録は見つかりません。" };
  if (entry.probe === null) {
    return { enabled: false, reason: "フォルダが見つかりません。「再指定」で選び直せます。" };
  }
  return OK;
}

/**
 * 「取ってきて取り込む」を押せるか（T-31。docs/DESIGN.md §8.6）。
 *
 * **押せなくてもメニューから消さない**（CLAUDE.md §6）。理由は `why` で返し、
 * 文言は `i18n/ja.ts` が持つ — ここで文字列を組むと、押せない理由だけ
 * 文言の集約から漏れる。
 *
 * 見るのは**取ってきても変わらないこと**だけ:
 *
 * - detached … 取り込む先のブランチが無い。fetch では変わらない
 * - ローカルブランチ … 取ってくる先が無い。fetch しても指す先は動かない
 *
 * **ahead / behind はここで見ない。** 取ってくると変わるので、いま分岐していても
 * 押させる（結果は取ってきてから Rust 側の判定が決める）。
 */
export type FetchMergeAvailability =
  | { enabled: true; why: null }
  | { enabled: false; why: "detached" | "localBranch" };

export function canFetchMerge(
  entryKind: RefEntry["kind"],
  /** HEAD が乗っているローカルブランチの短い名前。detached なら null。 */
  headBranch: string | null,
): FetchMergeAvailability {
  if (headBranch === null) return { enabled: false, why: "detached" };
  if (entryKind !== "remoteBranch") return { enabled: false, why: "localBranch" };
  return { enabled: true, why: null };
}
