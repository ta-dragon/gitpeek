/**
 * ブランチが取り込まれているか（T-38。docs/DESIGN.md §7.6）の結果と、調べる列。
 *
 * 印の相手は**幹だけ**（`RepositorySnapshot.defaultBranch`）。ほかの相手は右クリックの
 * 「このブランチを取り込んでいる可能性があるブランチを調べる…」で、全部のブランチと比べる
 * （相手を設定で選ばせるのは手間だった — 2026-09-19 に利用者の指摘）。
 *
 * **覚えるのはメモリだけ**（`state.json` に書かない — 2026-09-18 に利用者が了承）。鍵が
 * 「ブランチ名・相手名・両方の先端」なので、起動し直して調べ直しても結果は同じ。
 *
 * **判断は `lib/containment.ts` の純関数。** ここは列を 1 本ずつ流し、結果を置くだけ。
 * ブランチ一覧（`sidebar/RefTreeNode.tsx`）とチップ（`commits/RefChips.tsx`）の両方が読むので、
 * props で配らずにストアに置く（`store/snapshot.ts` と同じ作り）。
 */
import { useSyncExternalStore } from "react";

import {
  checkProgress,
  keyFor,
  nextToCheck,
  type CheckResult,
} from "../lib/containment";
import { checkContainment, type RefEntry } from "../lib/ipc";

export type ContainmentState = {
  /** 結果がどのリポジトリのものか。**切り替えたら捨てる。** */
  repositoryId: string | null;
  /** 印の相手（幹 ＝ `RepositorySnapshot.defaultBranch`）。決まらなければ null。 */
  target: string | null;
  cache: ReadonlyMap<string, CheckResult>;
  /** 右クリックから足したブランチ（リモートブランチはここからしか入らない）。**自動の列より先に流す。** */
  extra: readonly string[];
  /** いま調べているブランチ。 */
  running: string | null;
  /** 自動の列 ＋ 足したぶんの進み具合。 */
  progress: { done: number; total: number };
  /** 「このブランチを取り込んでいる可能性があるブランチを調べる…」の対象。null なら閉じている。 */
  containersFor: RefEntry | null;
};

let state: ContainmentState = {
  repositoryId: null,
  target: null,
  cache: new Map(),
  extra: [],
  running: null,
  progress: { done: 0, total: 0 },
  containersFor: null,
};

const listeners = new Set<() => void>();

function setState(next: Partial<ContainmentState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useContainment(): ContainmentState {
  return useSyncExternalStore(subscribe, () => state);
}

/**
 * 切り替えの世代。**前のリポジトリの結果が遅れて届いても置かない**
 * （`store/snapshot.ts` の `latestRequest` と同じ守り方）。
 */
let generation = 0;

/**
 * 列を 1 本ぶん進める。`App.tsx` の `ContainmentRunner` が、スナップショット・相手・
 * このストアのどれかが変わるたびに呼ぶ。**同時には 1 本しか走らせない**
 * （git の起動が重なると、大きなリポジトリで他の操作が詰まる）。
 */
export function pump(
  repositoryId: string | null,
  refs: readonly RefEntry[],
  target: string | null,
  auto: readonly string[],
): void {
  if (repositoryId !== state.repositoryId) {
    generation += 1;
    setState({
      repositoryId,
      target,
      cache: new Map(),
      extra: [],
      running: null,
      progress: { done: 0, total: 0 },
      containersFor: null,
    });
  }

  const queue = [...state.extra, ...auto];
  const progress = checkProgress(queue, state.cache, target, refs);
  if (
    target !== state.target ||
    progress.done !== state.progress.done ||
    progress.total !== state.progress.total
  ) {
    setState({ target, progress });
  }

  const against = target;
  if (repositoryId === null || state.running !== null || against === null) return;
  const branch = nextToCheck(queue, state.cache, against, refs);
  if (branch === null) return;
  // **鍵は頼んだ時点の位置で作る。** 画面が見ている先端と同じ組で覚えるため。
  const key = keyFor(branch, against, refs);
  if (key === null) return;

  const mine = generation;
  setState({ running: branch });
  void (async () => {
    let result: CheckResult;
    try {
      result = { kind: "done", outcome: await checkContainment(repositoryId, branch, against) };
    } catch (error) {
      result = { kind: "failed", reason: typeof error === "string" ? error : String(error) };
    }
    if (mine !== generation) return;
    const cache = new Map(state.cache);
    cache.set(key, result);
    setState({ cache, running: null });
  })();
}

/** 右クリックの「〈相手〉に入っているか調べる」。**列の先頭へ足す**だけで、流すのは `pump`。 */
export function requestCheck(branch: string): void {
  if (state.extra.includes(branch)) return;
  setState({ extra: [branch, ...state.extra] });
}

export function openContainers(entry: RefEntry): void {
  setState({ containersFor: entry });
}

export function closeContainers(): void {
  setState({ containersFor: null });
}
