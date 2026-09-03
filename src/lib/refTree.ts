/**
 * ref の一覧を階層構造へ畳む（docs/DESIGN.md §6.4）。
 *
 * **純関数だけを置く。** コンポーネントは組み上がった木を描くだけにして、
 * 「どこで畳むか」の判断はここでテストする（CLAUDE.md §8）。
 *
 * 表示文言はここに書かない。グループの見出しは `kind` と `remote` から
 * 呼び出し側が `ja.ts` で決める。
 */
import type { RefEntry, VisibleRefs } from "./ipc";

/**
 * 自動でフォルダに畳む最小件数。
 *
 * 2 件のために階層を 1 段深くすると、クリック数が増えるばかりで見通しが良くならない。
 * `feature/a` `feature/b` は 2 行のまま出したほうが速く読める。
 */
export const FOLDER_THRESHOLD = 3;

/**
 * タググループの ID。
 *
 * **これだけは既定で畳んでおく**（docs/DESIGN.md §6.4）。タグは数千本になることがあり
 * （onyx は 3,619 本）、開いたままだとブランチが画面から押し出される。
 * 畳んだ ID を保存する側の初期値としても使う（`state.json` の `collapsedTreeNodes`）。
 */
export const TAG_GROUP_ID = "tag";

export type RefTreeNode = RefFolder | RefLeaf;

export type RefFolder = {
  kind: "folder";
  /** 開閉状態の永続化キー。グループ ID ＋ パスなので ref 名とは衝突しない。 */
  id: string;
  label: string;
  children: RefTreeNode[];
  /** 配下にある ref の完全名。まとめてチェックを切り替えるときに使う。 */
  refNames: string[];
};

export type RefLeaf = {
  kind: "ref";
  /** ref の完全名（`refs/heads/main`）。 */
  id: string;
  /** 畳まれなかったぶんを含む表示名（`feature/a` のこともある）。 */
  label: string;
  entry: RefEntry;
};

export type RefGroupKind = "local" | "remote" | "tag";

/** ツリーの最上段。`ローカル` / `リモート > origin` / `タグ` の 3 種。 */
export type RefGroup = {
  id: string;
  kind: RefGroupKind;
  /** リモート名（`origin`）。他の種別では null。 */
  remote: string | null;
  children: RefTreeNode[];
  refNames: string[];
};

/**
 * ref 一覧をグループとフォルダに畳む。
 *
 * `filter` が空でなければ、短縮名に部分一致する ref だけを残してから畳む。
 * **絞り込んだ結果で畳み直す**ので、1 件だけ残ったフォルダは消えて平らになる。
 */
export function buildRefTree(refs: RefEntry[], filter = ""): RefGroup[] {
  const needle = filter.trim().toLowerCase();
  const matched =
    needle === ""
      ? refs
      : refs.filter((entry) => entry.shortName.toLowerCase().includes(needle));

  // グループ ID → そのグループに入る ref とパス。
  const buckets = new Map<string, { kind: RefGroupKind; remote: string | null; items: Item[] }>();

  for (const entry of matched) {
    const segments = entry.shortName.split("/");
    let id: string;
    let kind: RefGroupKind;
    let remote: string | null = null;
    let path: string[];

    if (entry.kind === "remoteBranch") {
      // 短縮名は `origin/feature/x`。先頭のリモート名はグループの見出しになるので外す。
      remote = segments[0] ?? "";
      path = segments.slice(1);
      // リモート名しか無い ref（ありえないが）を空パスにしない。
      if (path.length === 0) path = [remote];
      id = `remote:${remote}`;
      kind = "remote";
    } else if (entry.kind === "tag") {
      id = "tag";
      kind = "tag";
      path = segments;
    } else {
      id = "local";
      kind = "local";
      path = segments;
    }

    const bucket = buckets.get(id) ?? { kind, remote, items: [] };
    bucket.items.push({ path, entry });
    buckets.set(id, bucket);
  }

  const groups: RefGroup[] = [];
  for (const [id, bucket] of buckets) {
    const children = buildNodes(bucket.items, id);
    groups.push({
      id,
      kind: bucket.kind,
      remote: bucket.remote,
      children,
      refNames: bucket.items.map((item) => item.entry.name),
    });
  }

  // ローカル → リモート（名前順）→ タグ。手元のブランチを最初に見せたい。
  const rank = { local: 0, remote: 1, tag: 2 } as const;
  groups.sort(
    (a, b) => rank[a.kind] - rank[b.kind] || (a.remote ?? "").localeCompare(b.remote ?? ""),
  );
  return groups;
}

type Item = { path: string[]; entry: RefEntry };

/**
 * 同じ階層の項目をフォルダと葉に分ける。
 *
 * **フォルダにするのは「先頭セグメントが同じものが [`FOLDER_THRESHOLD`] 件以上」のときだけ。**
 * 満たないものは残りのパスを繋いだ 1 行の葉にする（`feature/a` のように出る）。
 * 同じ階層に `feature` というブランチと `feature/` フォルダが両方あってもよい。
 * 数えるのは配下（パスが 2 段以上）だけなので、ブランチ自身はフォルダに吸われない。
 */
function buildNodes(items: Item[], prefix: string): RefTreeNode[] {
  const leaves: Item[] = [];
  const nested = new Map<string, Item[]>();

  for (const item of items) {
    if (item.path.length <= 1) {
      leaves.push(item);
      continue;
    }
    const head = item.path[0];
    const list = nested.get(head);
    if (list === undefined) nested.set(head, [item]);
    else list.push(item);
  }

  const folders: RefFolder[] = [];
  for (const [head, group] of nested) {
    if (group.length < FOLDER_THRESHOLD) {
      // 畳まないので、残りのパスをそのまま葉の名前にする。
      leaves.push(...group);
      continue;
    }
    const id = `${prefix}/${head}`;
    const children = buildNodes(
      group.map((item) => ({ path: item.path.slice(1), entry: item.entry })),
      id,
    );
    folders.push({
      kind: "folder",
      id,
      label: head,
      children,
      refNames: group.map((item) => item.entry.name),
    });
  }

  folders.sort((a, b) => a.label.localeCompare(b.label));
  const sortedLeaves: RefLeaf[] = leaves
    .map((item) => ({
      kind: "ref" as const,
      id: item.entry.name,
      label: item.path.join("/"),
      entry: item.entry,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // フォルダを先に出す。同名のブランチがあるときも、まとまりが上に来るほうが読みやすい。
  return [...folders, ...sortedLeaves];
}

/* ---------- 可視 ref の操作（docs/DESIGN.md §4.4） ---------- */

/**
 * 非表示にされている ref 名の集合。
 *
 * 判定は 1 行ごとに走るので、配列の `includes` では ref が数千本あるリポジトリで
 * 効いてくる（onyx はタグ込みで 3,790 本）。木を描く前に 1 度だけ作ること。
 *
 * **タグはここに入らない。** タグは起点 ref ではないので（CLAUDE.md §2）、
 * チェックを外してもグラフが変わらない。意味の無いチェックボックスを置くより、
 * タグには最初から置かないほうが分かりやすい。
 */
export function excludedSet(visible: VisibleRefs): Set<string> {
  return new Set(visible.mode === "all" ? [] : visible.excluded);
}

/** 表示 / 非表示をまとめて切り替える。全部表示になったら `mode` を `all` へ戻す。 */
export function withVisibility(
  visible: VisibleRefs,
  names: string[],
  show: boolean,
): VisibleRefs {
  const excluded = new Set(visible.mode === "all" ? [] : visible.excluded);
  for (const name of names) {
    if (show) excluded.delete(name);
    else excluded.add(name);
  }
  return toVisibleRefs(excluded);
}

/** 指定した ref だけを表示する。プリセットと「このブランチだけ表示」で使う。 */
export function onlyVisible(allNames: string[], keep: string[]): VisibleRefs {
  const keepSet = new Set(keep);
  return toVisibleRefs(new Set(allNames.filter((name) => !keepSet.has(name))));
}

function toVisibleRefs(excluded: Set<string>): VisibleRefs {
  if (excluded.size === 0) return { mode: "all", excluded: [] };
  return { mode: "custom", excluded: [...excluded].sort() };
}

/**
 * グラフの起点になりうる ref の完全名（ブランチだけ）。
 *
 * プリセットの「全解除」「ローカルのみ」はここから作る。タグを混ぜてはいけない。
 */
export function branchNames(refs: RefEntry[], kind?: "localBranch" | "remoteBranch"): string[] {
  return refs
    .filter((entry) => (kind === undefined ? entry.kind !== "tag" : entry.kind === kind))
    .map((entry) => entry.name);
}

/** フォルダ配下のチェック状態。中途半端なら `partial`。 */
export type CheckState = "on" | "off" | "partial";

export function checkStateOf(excluded: Set<string>, names: string[]): CheckState {
  if (names.length === 0) return "on";
  let hidden = 0;
  for (const name of names) if (excluded.has(name)) hidden += 1;
  if (hidden === 0) return "on";
  return hidden === names.length ? "off" : "partial";
}
