/**
 * リポジトリの右クリックメニューの出し分け（T-30）。
 *
 * **押せない項目も消さない。** 押せる条件でだけ出すと、条件が成立しない場面で
 * 選択肢そのものが画面から消え、何が効いているのか読めなくなる（CLAUDE.md §6）。
 * 押せない形で残し、**理由を `reason` で返す**。
 *
 * 判定を `.tsx` に直書きするとテストが 1 つも当たらない（CLAUDE.md §8）。
 */
import type { RepositoryEntry } from "./ipc";

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
