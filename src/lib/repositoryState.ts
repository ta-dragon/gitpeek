/**
 * 登録 1 件がいまどういう状態か（T-44。純関数）。
 *
 * 起動直後は git を呼ばずに名前だけ先に並べ、フォルダの様子は並列に確かめる。そのため
 * **`probe === null` は「フォルダが無い」と「まだ確かめていない」の 2 通りに読める。**
 * 画面のあちこちで `probe` を直に見ると、確かめている間の登録が全部「見つかりません」に
 * なるので、読み分けはここを通す。
 */
import { ja } from "../i18n/ja";
import type { RepositoryEntry } from "./ipc";

export type RepositoryState =
  /** まだ確かめていない。**押せる**（グラフの読み込みは確かめるのを待たない）。 */
  | "checking"
  /** フォルダが無い。 */
  | "missing"
  /** フォルダはあるが、git のリポジトリではない。 */
  | "notRepository"
  | "ready";

export function repositoryState(entry: RepositoryEntry): RepositoryState {
  if (!entry.checked) return "checking";
  if (entry.probe === null) return "missing";
  if (!entry.probe.isRepository) return "notRepository";
  return "ready";
}

/**
 * 前回選んでいたものを、起動時に選び直してよいか（docs/DESIGN.md §13.1）。
 *
 * **フォルダが消えていれば選ばない。** 確かめている途中のものは選ぶ — 待つと、登録の数だけ
 * グラフが出るのが遅れる（T-44 で直した遅さそのもの）。
 */
export function canRestore(entry: RepositoryEntry): boolean {
  return repositoryState(entry) !== "missing";
}

/**
 * 何も選ばれていないときに出す 1 行。
 *
 * **読み終えるまで「登録されていません」と出さない。** 出すと、起動直後に一覧を読んでいる
 * あいだ、登録が消えたように見える（T-44 の発端）。
 */
export function noSelectionText(loaded: boolean, registered: number): string {
  if (!loaded) return ja.repositories.loadingList;
  return registered === 0 ? ja.repositories.empty : ja.repositories.pickOne;
}
