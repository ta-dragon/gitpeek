/**
 * 「比べる…」ダイアログ（T-41。docs/DESIGN.md §10.3）を開いているか。
 *
 * 入口がブランチ一覧（`sidebar/RefTree.tsx`）とチップ（`commits/CommitList.tsx`）の 2 か所にあり、
 * 置き場所は比較の選択を持つ `App.tsx` の `CommitWorkspace` なので、props で配らずにストアに置く
 * （`store/containment.ts` の `containersFor` と同じ作り）。**覚えるのはメモリだけ。**
 */
import { useSyncExternalStore } from "react";

import type { RefEntry } from "../lib/ipc";

/** 押された ref。null なら閉じている。 */
let state: RefEntry | null = null;

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function set(next: RefEntry | null): void {
  state = next;
  for (const listener of listeners) listener();
}

export function useBranchCompare(): RefEntry | null {
  return useSyncExternalStore(subscribe, () => state);
}

export function openBranchCompare(entry: RefEntry): void {
  set(entry);
}

export function closeBranchCompare(): void {
  set(null);
}
