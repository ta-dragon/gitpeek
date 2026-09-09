import { describe, expect, it } from "vitest";

import type { CommitMeta, RefEntry } from "./ipc";
import {
  branchNames,
  branchesUpdatedSince,
  buildRefTree,
  checkStateOf,
  commitTimes,
  excludedSet,
  isHeadRef,
  onlyVisible,
  startOfDay,
  withVisibility,
  type RefGroup,
  type RefTreeNode,
} from "./refTree";

function ref(shortName: string, kind: RefEntry["kind"] = "localBranch"): RefEntry {
  const prefix = kind === "tag" ? "refs/tags/" : kind === "remoteBranch" ? "refs/remotes/" : "refs/heads/";
  return {
    name: `${prefix}${shortName}`,
    shortName,
    kind,
    target: `sha-${shortName}`,
    upstream: null,
    outOfGraph: false,
    orphan: false,
  };
}

function commit(sha: string, commitTime: number): CommitMeta {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    parents: [],
    authorName: "t",
    authorEmail: "t@example.com",
    authorTime: commitTime,
    commitTime,
    subject: "s",
  };
}

/** 木を「フォルダ名/」と葉のラベルの並びに落として比べる。 */
function shape(nodes: RefTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "folder"
      ? [`${node.label}/`, ...shape(node.children).map((line) => `  ${line}`)]
      : [node.label],
  );
}

function group(groups: RefGroup[], id: string): RefGroup {
  const found = groups.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`グループ ${id} が無い`);
  return found;
}

describe("buildRefTree", () => {
  it("2 件では畳まず、パスをそのまま出す", () => {
    const tree = buildRefTree([ref("feature/a"), ref("feature/b"), ref("main")]);

    expect(shape(group(tree, "local").children)).toEqual(["feature/a", "feature/b", "main"]);
  });

  it("3 件からフォルダに畳む", () => {
    const tree = buildRefTree([
      ref("feature/a"),
      ref("feature/b"),
      ref("feature/c"),
      ref("main"),
    ]);

    expect(shape(group(tree, "local").children)).toEqual([
      "feature/",
      "  a",
      "  b",
      "  c",
      "main",
    ]);
  });

  it("多段にネストする", () => {
    const tree = buildRefTree([
      ref("feature/ui/a"),
      ref("feature/ui/b"),
      ref("feature/ui/c"),
      ref("feature/core/x"),
      ref("feature/core/y"),
    ]);

    // feature は 5 件なので畳む。その中で ui は 3 件なので畳み、core は 2 件なので畳まない。
    expect(shape(group(tree, "local").children)).toEqual([
      "feature/",
      "  ui/",
      "    a",
      "    b",
      "    c",
      "  core/x",
      "  core/y",
    ]);
  });

  it("フォルダ名と同じ名前のブランチはフォルダに吸われない", () => {
    const tree = buildRefTree([
      ref("feature"),
      ref("feature/a"),
      ref("feature/b"),
      ref("feature/c"),
    ]);

    // フォルダが先、同名のブランチはその隣に葉として残る。
    expect(shape(group(tree, "local").children)).toEqual([
      "feature/",
      "  a",
      "  b",
      "  c",
      "feature",
    ]);
    // ID が衝突していないこと（開閉状態とチェックの取り違えを防ぐ）。
    const [folder, leaf] = group(tree, "local").children;
    expect(folder.id).not.toBe(leaf.id);
    expect(leaf.id).toBe("refs/heads/feature");
  });

  it("リモートはリモート名でグループを分け、ブランチ名からは外す", () => {
    const tree = buildRefTree([
      ref("origin/main", "remoteBranch"),
      ref("origin/feature/a", "remoteBranch"),
      ref("upstream/main", "remoteBranch"),
      ref("main"),
    ]);

    expect(tree.map((entry) => entry.id)).toEqual([
      "local",
      "remote:origin",
      "remote:upstream",
    ]);
    expect(group(tree, "remote:origin").remote).toBe("origin");
    expect(shape(group(tree, "remote:origin").children)).toEqual(["feature/a", "main"]);
  });

  it("ローカル → リモート → タグの順に並ぶ", () => {
    const tree = buildRefTree([ref("v1.0", "tag"), ref("origin/main", "remoteBranch"), ref("main")]);

    expect(tree.map((entry) => entry.kind)).toEqual(["local", "remote", "tag"]);
  });

  it("絞り込んだ結果で畳み直す", () => {
    const refs = [ref("feature/a"), ref("feature/b"), ref("feature/c")];

    // 3 件そろえば畳むが、1 件に絞られたら階層は消える。
    expect(shape(group(buildRefTree(refs), "local").children)).toEqual([
      "feature/",
      "  a",
      "  b",
      "  c",
    ]);
    expect(shape(group(buildRefTree(refs, "FEATURE/A"), "local").children)).toEqual([
      "feature/a",
    ]);
  });

  it("一致しない絞り込みではグループごと消える", () => {
    expect(buildRefTree([ref("main")], "zzz")).toEqual([]);
  });

  it("フォルダは配下の ref 名をすべて持つ", () => {
    const tree = buildRefTree([ref("feature/a"), ref("feature/b"), ref("feature/c")]);
    const folder = group(tree, "local").children[0];

    expect(folder.kind).toBe("folder");
    if (folder.kind !== "folder") return;
    expect(folder.refNames).toEqual([
      "refs/heads/feature/a",
      "refs/heads/feature/b",
      "refs/heads/feature/c",
    ]);
  });
});

describe("可視 ref", () => {
  const refs = [ref("main"), ref("origin/main", "remoteBranch"), ref("v1.0", "tag")];

  it("全部表示なら mode は all のまま", () => {
    const visible = withVisibility({ mode: "all", excluded: [] }, ["refs/heads/main"], true);
    expect(visible).toEqual({ mode: "all", excluded: [] });
  });

  it("1 本外すと custom になり、戻すと all に帰る", () => {
    const hidden = withVisibility({ mode: "all", excluded: [] }, ["refs/heads/main"], false);
    expect(hidden).toEqual({ mode: "custom", excluded: ["refs/heads/main"] });

    expect(withVisibility(hidden, ["refs/heads/main"], true)).toEqual({
      mode: "all",
      excluded: [],
    });
  });

  it("プリセットはタグを除外に入れない", () => {
    // 「ローカルのみ」＝ ローカルブランチ以外のブランチを外す。
    const localOnly = onlyVisible(branchNames(refs), branchNames(refs, "localBranch"));
    expect(localOnly.excluded).toEqual(["refs/remotes/origin/main"]);
  });

  it("チェック状態は on / off / partial を返す", () => {
    const names = ["refs/heads/a", "refs/heads/b"];
    expect(checkStateOf(excludedSet({ mode: "all", excluded: [] }), names)).toBe("on");
    expect(
      checkStateOf(excludedSet({ mode: "custom", excluded: ["refs/heads/a"] }), names),
    ).toBe("partial");
    expect(checkStateOf(excludedSet({ mode: "custom", excluded: names }), names)).toBe("off");
  });
});

describe("HEAD が乗っている ref", () => {
  /** **`HeadInfo.branch` は短い名前。** 完全な ref 名と比べると必ず false になり、
   *  HEAD の印が一度も出ない（T-18 で発覚）。 */
  it("短い名前で比べる", () => {
    expect(isHeadRef(ref("main"), "main")).toBe(true);
    expect(isHeadRef(ref("main"), "refs/heads/main")).toBe(false);
  });

  it("別のブランチには立たない", () => {
    expect(isHeadRef(ref("feature"), "main")).toBe(false);
  });

  it("detached では立たない", () => {
    expect(isHeadRef(ref("main"), null)).toBe(false);
  });

  /** ブランチと同じ名前のタグは作れる。**名前だけで比べると取り違える。** */
  it("同じ名前のタグには立たない", () => {
    expect(isHeadRef(ref("main", "tag"), "main")).toBe(false);
  });

  it("リモート追跡ブランチにも立たない", () => {
    expect(isHeadRef(ref("main", "remoteBranch"), "main")).toBe(false);
  });
});

describe("startOfDay", () => {
  it("その日の 0 時をローカル時刻で返す", () => {
    // **`new Date("2026-09-01")` は UTC の 0 時**になる。日本時間ではその日の 09:00 で、
    // 前日の夕方に積んだコミットが「9 月 1 日以降」に入ってしまう。
    expect(startOfDay("2026-09-01")).toBe(new Date(2026, 8, 1).getTime());

    const parsed = new Date(startOfDay("2026-09-01") ?? 0);
    expect(parsed.getHours()).toBe(0);
    expect(parsed.getDate()).toBe(1);
  });

  it("読めない日付は null", () => {
    expect(startOfDay("")).toBeNull();
    expect(startOfDay("2026-9-1")).toBeNull();
    expect(startOfDay("きのう")).toBeNull();
  });

  it("存在しない日付は繰り上げずに null", () => {
    // `new Date(2026, 1, 30)` は 3 月 2 日になる。黙って別の日で絞られる。
    expect(startOfDay("2026-02-30")).toBeNull();
  });
});

describe("branchesUpdatedSince", () => {
  const since = new Date(2026, 8, 1).getTime();
  const before = Math.floor(since / 1000) - 1;
  const after = Math.floor(since / 1000) + 1;

  it("その日ちょうどのブランチも選ぶ", () => {
    const times = new Map([["sha-main", Math.floor(since / 1000)]]);

    expect(branchesUpdatedSince([ref("main")], since, times)).toEqual(["refs/heads/main"]);
  });

  it("古いブランチは選ばない", () => {
    const times = new Map([
      ["sha-new", after],
      ["sha-old", before],
    ]);
    const refs = [ref("new"), ref("old")];

    expect(branchesUpdatedSince(refs, since, times)).toEqual(["refs/heads/new"]);
  });

  it("タグは選ばない", () => {
    // タグにはチェックボックスが無いので、返しても付けようがない。
    const times = new Map([["sha-v1.0", after]]);

    expect(branchesUpdatedSince([ref("v1.0", "tag")], since, times)).toEqual([]);
  });

  it("時刻を引けないブランチは選ばない", () => {
    // グラフの外を指していると、その日以降かどうか言い切れない。
    expect(branchesUpdatedSince([ref("main")], since, new Map())).toEqual([]);
  });

  it("リモート追跡ブランチも選ぶ", () => {
    const times = new Map([["sha-origin/main", after]]);
    const refs = [ref("origin/main", "remoteBranch")];

    expect(branchesUpdatedSince(refs, since, times)).toEqual(["refs/remotes/origin/main"]);
  });
});

describe("commitTimes", () => {
  it("sha からコミット時刻を引ける", () => {
    const times = commitTimes([commit("a", 100), commit("b", 200)]);

    expect(times.get("a")).toBe(100);
    expect(times.get("b")).toBe(200);
    expect(times.get("c")).toBeUndefined();
  });
});
