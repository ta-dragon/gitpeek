/**
 * ファイルを変えたコミットを辿る（T-40。純関数。docs/DESIGN.md §6.7）。
 *
 * 探すのはコミット検索そのもの（`path:` を打つのと同じ）。ここが決めるのは、
 * **右クリックの項目を押せるか**と、**当たりへ移ったときにどのファイルを選ぶか**だけ。
 */
import { pathQuery } from "./commitQuery";

/** 右クリックの「このファイルを変えたコミットに印を付ける」。**押せなくても消さない**（CLAUDE.md §6）。 */
export type FileHistoryAction =
  /** 押せる。`input` を検索欄に入れて探す。 */
  | { kind: "ready"; input: string }
  /** まだ一度もコミットされていない（作業ツリーの未追跡）。探しても何も出ない。 */
  | { kind: "untracked" }
  /** パスに `"` を含み、打ち方で書けない。 */
  | { kind: "unquotable" };

export function fileHistoryAction(path: string, untracked: boolean): FileHistoryAction {
  if (untracked) return { kind: "untracked" };
  const input = pathQuery(path);
  return input === null ? { kind: "unquotable" } : { kind: "ready", input };
}

/** 変更ファイル一覧の 1 行のうち、ここで見るところ。 */
export type ChangedPath = { path: string; oldPath: string | null };

/**
 * そのコミットの変更ファイルのうち、辿った名前に当たるもの（選ぶパス）。
 *
 * **改名の前後で名前が違う**ので、いま選んでいるパスと同じものを探すだけでは、改名より
 * 前のコミットで何も選ばれない。**打った名前から順に**見て、最初に当たったものを返す。
 * 改名したコミットでは新しい名前（`path`）の側を返す（差分はそちらで引く）。
 */
export function historyFileIn(
  changes: readonly ChangedPath[],
  names: readonly string[],
): string | null {
  for (const name of names) {
    const hit = changes.find((change) => change.path === name || change.oldPath === name);
    if (hit !== undefined) return hit.path;
  }
  return null;
}

/**
 * コミットの変更ファイルが読めたときに選び直すパス。**選び直さなくてよければ `null`。**
 *
 * 1. ファイルで探しているなら（`names` が空でない）、**そのファイルのそのコミットでの名前**
 * 2. いま選んでいるパスが一覧にあれば、そのまま
 * 3. どちらでもなければ先頭（コミットを移ると前のファイルはたいてい変わっていないので、
 *    毎回「選択なし」になるより先頭が出るほうが速い。§7.3）
 */
export function fileToSelect(
  changes: readonly ChangedPath[],
  selected: string | null,
  names: readonly string[],
): string | null {
  if (changes.length === 0) return null;
  const target = historyFileIn(changes, names);
  if (target !== null) return target === selected ? null : target;
  if (selected !== null && changes.some((change) => change.path === selected)) return null;
  return changes[0].path;
}
