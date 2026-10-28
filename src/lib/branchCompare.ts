/**
 * ブランチ同士を比べる（T-41。docs/DESIGN.md §10.3。純関数）。
 *
 * **比べる仕組みは 2 点比較（T-15）そのもの。** ここが決めるのは、ダイアログを開いたときに
 * 何を入れておくか・押せるか・比較バーに出す名前と件数だけ。選んだ ref は**その時点の SHA**
 * にして `compareCommit` / `selectedCommit` へ入れる（`state.json` に ref 名を足さない）。
 */
import type { RefEntry } from "./ipc";

/** ダイアログの両端。完全な ref 名（`refs/heads/main`）。選んでいなければ null。 */
export type CompareEnds = { from: string | null; to: string | null };

/**
 * ダイアログを開いたときの両端。**押した ref が比較先**、比較元は幹。
 *
 * 押したのが幹そのものなら、HEAD の乗っているブランチを比較元にする（幹と幹を比べても空になる）。
 * それも同じなら空欄で開く。**一覧に無い名前は入れない** — 入れると、選べない値が
 * 選ばれたまま「比べる」を押せることになる。
 */
export function compareDefaults(
  entry: RefEntry,
  refs: readonly RefEntry[],
  /** 幹の完全な ref 名（`RepositorySnapshot.defaultBranch`）。 */
  defaultBranch: string | null,
  /** HEAD が乗っているローカルブランチの短い名前。detached なら null。 */
  headBranch: string | null,
): CompareEnds {
  const known = (name: string | null) =>
    name !== null && name !== entry.name && refs.some((ref) => ref.name === name);
  const head = headBranch === null ? null : `refs/heads/${headBranch}`;

  const from = known(defaultBranch) ? defaultBranch : known(head) ? head : null;
  return { from, to: entry.name };
}

/** 「比べる」を押せるか。**押せないときは理由を種類で返す**（CLAUDE.md §6）。 */
export type CompareReadiness =
  | { kind: "ready"; from: string; to: string }
  | { kind: "missing" }
  | { kind: "sameRef" }
  | { kind: "sameCommit" };

/**
 * 押せるか。**同じ SHA を指す 2 つも押せない** — 差分が空になるだけで、比較の見た目だけが残る
 * （`selectCommit` が自分自身との比較にしないのと同じ）。
 *
 * 返す `from` / `to` は **SHA**（ref 名ではない）。始めた時点の位置で比べる。
 */
export function compareReadiness(
  ends: CompareEnds,
  refs: readonly RefEntry[],
): CompareReadiness {
  const from = refs.find((ref) => ref.name === ends.from);
  const to = refs.find((ref) => ref.name === ends.to);
  if (from === undefined || to === undefined) return { kind: "missing" };
  if (from.name === to.name) return { kind: "sameRef" };
  if (from.target === to.target) return { kind: "sameCommit" };
  return { kind: "ready", from: from.target, to: to.target };
}

/** ローカル → リモート → タグ。ブランチ一覧の並びと同じにして、見比べられるようにする。 */
const KIND_ORDER = { localBranch: 0, remoteBranch: 1, tag: 2 } as const;

function byKindThenName(a: RefEntry, b: RefEntry): number {
  const kind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (kind !== 0) return kind;
  // localeCompare は環境で並びが変わる。テストが再現するよう素の比較にする。
  return a.shortName < b.shortName ? -1 : a.shortName > b.shortName ? 1 : 0;
}

/**
 * ダイアログの一覧に出す ref。`filter` は短い名前の部分一致（大文字小文字は区別しない）。
 *
 * **選んでいるものは絞り込みで消さない。** 消すと、何が選ばれているのか一覧から読めなくなる。
 */
export function compareChoices(
  refs: readonly RefEntry[],
  filter: string,
  selected: string | null,
): RefEntry[] {
  const needle = filter.trim().toLowerCase();
  return refs
    .filter(
      (ref) =>
        needle === "" || ref.name === selected || ref.shortName.toLowerCase().includes(needle),
    )
    .sort(byKindThenName);
}

/**
 * その SHA を指している ref の短い名前（比較バーに出す）。
 *
 * **fetch で ref が動けば名前は消える。** 比較は始めた時点の SHA のままなので、
 * 名前だけ追いかけると「見ている差分」と「書いてある名前」が食い違う。
 */
export function refsAt(sha: string, refs: readonly RefEntry[]): string[] {
  return refs
    .filter((ref) => ref.target === sha)
    .sort(byKindThenName)
    .map((ref) => ref.shortName);
}

/** 片側にだけあるコミットの数。どちらかが読み込んだ集合の外なら数えられない。 */
export type CompareCounts =
  | { kind: "counted"; onlyInFrom: number; onlyInTo: number }
  | { kind: "unknown" };

/**
 * 片側にだけあるコミットを数える。**git は呼ばない**（CLAUDE.md §2 — `rev-list --count` を使わず
 * メモリ上のグラフから）。全コミットはフロントに揃っている（CLAUDE.md §3.4）。
 *
 * 両側から辿り切って差を取る素朴な形。Rust の `CommitIndex::ahead_behind` は共通祖先で
 * 止めて速くしているが、こちらは比較を始めたときに 1 度数えるだけなので、正しさが一目で
 * 分かるほうを取った。**意味は同じ**（`git rev-list --count A..B` と `B..A`）。
 */
export function compareCounts(
  commits: ReadonlyMap<string, { parents: readonly string[] }>,
  from: string,
  to: string,
): CompareCounts {
  if (!commits.has(from) || !commits.has(to)) return { kind: "unknown" };
  if (from === to) return { kind: "counted", onlyInFrom: 0, onlyInTo: 0 };

  const fromSide = reachable(commits, from);
  const toSide = reachable(commits, to);
  let onlyInFrom = 0;
  for (const sha of fromSide) if (!toSide.has(sha)) onlyInFrom += 1;
  let onlyInTo = 0;
  for (const sha of toSide) if (!fromSide.has(sha)) onlyInTo += 1;
  return { kind: "counted", onlyInFrom, onlyInTo };
}

/** `tip` から親を辿って届くコミット（`tip` 自身を含む）。手元に無い親はそこで止める。 */
function reachable(
  commits: ReadonlyMap<string, { parents: readonly string[] }>,
  tip: string,
): Set<string> {
  const seen = new Set<string>([tip]);
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    for (const parent of commits.get(sha)?.parents ?? []) {
      if (!seen.has(parent) && commits.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return seen;
}
