/**
 * 作業ツリーの一覧を組み立てる（純関数。docs/DESIGN.md §7.5, §14.4）。
 *
 * **同じパスがステージ済みと未ステージの両方に出る。** `git add` したあとに
 * もう一度直せばそうなるので、選択の鍵はパスだけでは足りない。
 */
import type { FileChange, WorkingSection, WorkingTree } from "./ipc";

/** 一覧の 1 行。未追跡と衝突は差分を持たないので `change` が null。 */
export type WorkingEntry = {
  section: WorkingSection;
  path: string;
  change: FileChange | null;
};

/** どのセクションのどのパスを見ているか。**永続化しない**（その場の判断）。 */
export type WorkingSelection = { section: WorkingSection; path: string };

/**
 * セクションの並び順。
 *
 * **衝突が先頭。** 直さないと先へ進めないので、下に埋もれさせない。
 * 残りは DESIGN.md §7.5 の並び（ステージ済み → 未ステージ → 未追跡）。
 */
export const SECTION_ORDER: WorkingSection[] = ["unmerged", "staged", "unstaged", "untracked"];

/** 一覧を平らに並べる。`Alt+↑` / `Alt+↓` はこの順で動く。 */
export function workingEntries(tree: WorkingTree | null): WorkingEntry[] {
  if (tree === null) return [];

  const entries: WorkingEntry[] = [];
  for (const section of SECTION_ORDER) {
    for (const entry of sectionEntries(tree, section)) entries.push(entry);
  }
  return entries;
}

/** 1 つのセクションの中身。 */
export function sectionEntries(tree: WorkingTree, section: WorkingSection): WorkingEntry[] {
  switch (section) {
    case "staged":
      return tree.staged.map((change) => ({ section, path: change.path, change }));
    case "unstaged":
      return tree.unstaged.map((change) => ({ section, path: change.path, change }));
    case "untracked":
      return tree.untracked.map((path) => ({ section, path, change: null }));
    case "unmerged":
      return tree.unmerged.map((path) => ({ section, path, change: null }));
  }
}

/**
 * 選択の鍵。**セクションを含める** — 同じパスが 2 つのセクションに出るため。
 *
 * 区切りに改行を使う。パスに使えない文字ではないが、`/` や `:` よりは紛れにくい。
 */
export function entryKey(entry: WorkingSelection): string {
  return `${entry.section}\n${entry.path}`;
}

/** 鍵から選択へ戻す。壊れていれば null（保存していないので普通は起きない）。 */
export function parseKey(key: string): WorkingSelection | null {
  const at = key.indexOf("\n");
  if (at <= 0) return null;
  const section = key.slice(0, at);
  if (!SECTION_ORDER.includes(section as WorkingSection)) return null;
  return { section: section as WorkingSection, path: key.slice(at + 1) };
}

/** 何も変わっていないか。**擬似行を出すかどうかの判断はこれ 1 つ。** */
export function isClean(tree: WorkingTree | null): boolean {
  return tree === null || workingEntries(tree).length === 0;
}

/** 擬似行に出す要約。 */
export type WorkingSummary = { staged: number; unstaged: number; untracked: number; unmerged: number };

export function summarize(tree: WorkingTree | null): WorkingSummary {
  return {
    staged: tree?.staged.length ?? 0,
    unstaged: tree?.unstaged.length ?? 0,
    untracked: tree?.untracked.length ?? 0,
    unmerged: tree?.unmerged.length ?? 0,
  };
}

/**
 * その選択がまだ一覧にあるか。
 *
 * 外部で `git add` されると、選んでいた行がセクションごと消えることがある。
 */
export function stillListed(
  entries: WorkingEntry[],
  selection: WorkingSelection | null,
): boolean {
  if (selection === null) return false;
  const key = entryKey(selection);
  return entries.some((entry) => entryKey(entry) === key);
}
