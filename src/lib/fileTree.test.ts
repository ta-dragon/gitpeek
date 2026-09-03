import { describe, expect, it } from "vitest";

import { buildFileTree, splitPath, totalChanges, type FileTreeNode } from "./fileTree";
import type { FileChange } from "./ipc";

function change(path: string, additions: number | null = 1, deletions: number | null = 0): FileChange {
  return {
    path,
    oldPath: null,
    status: "modified",
    additions,
    deletions,
    oldMode: "100644",
    newMode: "100644",
  };
}

/** 木を「ディレクトリ名/」と葉の並びに落として比べる。 */
function shape(nodes: FileTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "dir"
      ? [`${node.label}/`, ...shape(node.children).map((line) => `  ${line}`)]
      : [node.label],
  );
}

describe("buildFileTree", () => {
  it("ルート直下のファイルはそのまま並ぶ", () => {
    expect(shape(buildFileTree([change("b.txt"), change("a.txt")]))).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  it("ディレクトリを先に、その中は名前順に並べる", () => {
    const tree = buildFileTree([
      change("z.txt"),
      change("src/b.ts"),
      change("src/a.ts"),
      change("docs/x.md"),
    ]);

    expect(shape(tree)).toEqual(["docs/", "  x.md", "src/", "  a.ts", "  b.ts", "z.txt"]);
  });

  it("子が 1 つだけのディレクトリの連なりは 1 行にまとめる", () => {
    const tree = buildFileTree([change("src/components/diff/DiffPane.tsx")]);

    expect(shape(tree)).toEqual(["src/components/diff/", "  DiffPane.tsx"]);
    expect(tree[0].id).toBe("src/components/diff");
  });

  it("分岐したところで畳むのをやめる", () => {
    const tree = buildFileTree([
      change("src/components/diff/DiffPane.tsx"),
      change("src/components/graph/CommitGraph.tsx"),
    ]);

    expect(shape(tree)).toEqual([
      "src/components/",
      "  diff/",
      "    DiffPane.tsx",
      "  graph/",
      "    CommitGraph.tsx",
    ]);
  });

  it("ファイルがあるディレクトリは畳まない", () => {
    // src に直接ファイルがあるので、src と lib は別の行になる。
    const tree = buildFileTree([change("src/main.tsx"), change("src/lib/ipc.ts")]);

    expect(shape(tree)).toEqual(["src/", "  lib/", "    ipc.ts", "  main.tsx"]);
  });

  it("配下のファイル数を数える", () => {
    const tree = buildFileTree([
      change("src/a.ts"),
      change("src/sub/b.ts"),
      change("src/sub/c.ts"),
    ]);

    const src = tree[0];
    expect(src.kind).toBe("dir");
    if (src.kind !== "dir") return;
    expect(src.fileCount).toBe(3);
  });

  it("日本語のパスも同じように畳む", () => {
    const tree = buildFileTree([change("ディレクトリ/入れ子のファイル.txt")]);

    expect(shape(tree)).toEqual(["ディレクトリ/", "  入れ子のファイル.txt"]);
  });

  it("空の入力は空の木", () => {
    expect(buildFileTree([])).toEqual([]);
  });
});

describe("splitPath", () => {
  it("ディレクトリとファイル名に割る", () => {
    expect(splitPath("src/lib/ipc.ts")).toEqual({ dir: "src/lib/", name: "ipc.ts" });
  });

  it("ルート直下はディレクトリが空", () => {
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

describe("totalChanges", () => {
  it("増減を合計する", () => {
    const total = totalChanges([change("a", 3, 1), change("b", 2, 5)]);
    expect(total).toEqual({ files: 2, additions: 5, deletions: 6, binaries: 0 });
  });

  it("バイナリは 0 として足さず、件数で数える", () => {
    const total = totalChanges([change("a", 3, 1), change("blob.bin", null, null)]);
    expect(total).toEqual({ files: 2, additions: 3, deletions: 1, binaries: 1 });
  });
});
