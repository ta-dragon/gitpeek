/**
 * 変更ファイル一覧をディレクトリツリーへ畳む（docs/DESIGN.md §7.3）。
 *
 * **純関数だけを置く。** ref ツリー（[`./refTree`]）とは畳み方の規則が違うので分けてある。
 * ref は「同じ接頭辞が 3 件以上なら畳む」だが、ファイルは**実際のディレクトリ構造**が
 * そのまま意味を持つので、1 件でもディレクトリはディレクトリとして出す。
 * 代わりに**子が 1 つしかないディレクトリの連なりは 1 行にまとめる**
 * （`src/components/diff` を 3 行に割っても情報が増えない）。
 */
import type { FileChange } from "./ipc";

export type FileTreeNode = FileTreeDir | FileTreeFile;

export type FileTreeDir = {
  kind: "dir";
  /** 開閉状態の永続化キー。ルートからのパス。 */
  id: string;
  /** まとめた結果、`src/components/diff` のように複数段になることがある。 */
  label: string;
  children: FileTreeNode[];
  /** 配下のファイル数。 */
  fileCount: number;
};

export type FileTreeFile = {
  kind: "file";
  /** 変更後のパス。一覧の選択キーでもある。 */
  id: string;
  /** ファイル名だけ。 */
  label: string;
  change: FileChange;
};

/**
 * パス一覧をツリーにする。並びは**ディレクトリが先、その中は名前順**。
 *
 * 入力の順序には依存しない（git の出力順はコミットによって変わる）。
 */
export function buildFileTree(changes: FileChange[]): FileTreeNode[] {
  const root: Dir = { dirs: new Map(), files: [] };

  for (const change of changes) {
    const segments = change.path.split("/");
    const name = segments.pop() ?? change.path;
    let node = root;
    for (const segment of segments) {
      let next = node.dirs.get(segment);
      if (next === undefined) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.push({ name, change });
  }

  return toNodes(root, "");
}

type Dir = {
  dirs: Map<string, Dir>;
  files: { name: string; change: FileChange }[];
};

function toNodes(dir: Dir, prefix: string): FileTreeNode[] {
  const dirs: FileTreeDir[] = [];
  for (const [name, child] of dir.dirs) {
    dirs.push(collapse(child, prefix === "" ? name : `${prefix}/${name}`, name));
  }
  dirs.sort((a, b) => a.label.localeCompare(b.label));

  const files: FileTreeFile[] = dir.files
    .map((file) => ({
      kind: "file" as const,
      id: file.change.path,
      label: file.name,
      change: file.change,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return [...dirs, ...files];
}

/**
 * 子がディレクトリ 1 つだけの連なりを 1 行にまとめる。
 *
 * `src` の下に `components` しか無く、その下に `diff` しか無いなら
 * `src/components/diff` の 1 行にする。**ファイルが 1 つでもあれば止める**
 * （そこは実際に分岐している）。
 */
function collapse(dir: Dir, path: string, label: string): FileTreeDir {
  let current = dir;
  let currentPath = path;
  let currentLabel = label;

  while (current.files.length === 0 && current.dirs.size === 1) {
    const [name, child] = [...current.dirs][0];
    current = child;
    currentPath = `${currentPath}/${name}`;
    currentLabel = `${currentLabel}/${name}`;
  }

  const children = toNodes(current, currentPath);
  return {
    kind: "dir",
    id: currentPath,
    label: currentLabel,
    children,
    fileCount: countFiles(children),
  };
}

function countFiles(nodes: FileTreeNode[]): number {
  let total = 0;
  for (const node of nodes) total += node.kind === "file" ? 1 : node.fileCount;
  return total;
}

/**
 * フラット表示用にディレクトリとファイル名へ割る。
 *
 * ディレクトリ側を淡色にしてファイル名を強調する（docs/DESIGN.md §7.3）。
 * ルート直下のファイルはディレクトリが空文字になる。
 */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  if (cut < 0) return { dir: "", name: path };
  return { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/** 変更ファイル一覧の合計。ヘッダに出す。 */
export function totalChanges(changes: FileChange[]): {
  files: number;
  additions: number;
  deletions: number;
  binaries: number;
} {
  let additions = 0;
  let deletions = 0;
  let binaries = 0;
  for (const change of changes) {
    // バイナリは行数を持たない。0 として足すと「変更なし」と見分けが付かなくなるので数える。
    if (change.additions === null || change.deletions === null) {
      binaries += 1;
      continue;
    }
    additions += change.additions;
    deletions += change.deletions;
  }
  return { files: changes.length, additions, deletions, binaries };
}
