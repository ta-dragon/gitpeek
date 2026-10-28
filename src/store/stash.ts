/**
 * stash の一覧と、どれを見ているか（T-42。docs/DESIGN.md §7.5.1）。
 *
 * 一覧はブランチ一覧（`sidebar/StashList.tsx`）が、見ているものは `App.tsx` の `CommitWorkspace` が
 * 読むので、props で配らずにストアに置く（`store/containment.ts` と同じ作り）。
 *
 * **読むのはスナップショットと同じきっかけ**（開いたとき・F5・書き込みのあと）。`App.tsx` の
 * `StashRunner` がスナップショットの読み直しに合わせて `reload` を呼ぶ。
 * **見ているものは残さない**（`state.json` に書かない。番号は stash を足すたびにずれる）。
 */
import { useSyncExternalStore } from "react";

import { loadStashList, type StashEntry } from "../lib/ipc";
import { stillStashed } from "../lib/stash";

export type StashState = {
  /** 一覧がどのリポジトリのものか。**切り替えたら捨てる。** */
  repositoryId: string | null;
  /** 読めていなければ null（読んでいる途中、または失敗）。 */
  entries: StashEntry[] | null;
  error: string | null;
  /** 見ている stash の SHA。null なら見ていない。 */
  selected: string | null;
};

let state: StashState = { repositoryId: null, entries: null, error: null, selected: null };

const listeners = new Set<() => void>();

function setState(next: Partial<StashState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useStash(): StashState {
  return useSyncExternalStore(subscribe, () => state);
}

/** 何回目の読み込みか。**古い応答を置かない**（`store/snapshot.ts` の `latestRequest` と同じ守り方）。 */
let latest = 0;

/**
 * 読み直す。リポジトリが変わったら、前の一覧と選択を先に捨てる。
 * **読み直しても同じ stash を見続ける**（SHA で引く）。消えていたら見るのをやめる。
 */
export function reload(repositoryId: string | null): void {
  const mine = (latest += 1);
  if (repositoryId !== state.repositoryId) {
    setState({ repositoryId, entries: null, error: null, selected: null });
  }
  if (repositoryId === null) return;

  void (async () => {
    try {
      const entries = await loadStashList(repositoryId);
      if (mine !== latest) return;
      setState({ entries, error: null, selected: stillStashed(entries, state.selected) });
    } catch (error) {
      if (mine !== latest) return;
      setState({
        entries: null,
        error: typeof error === "string" ? error : String(error),
        selected: null,
      });
    }
  })();
}

export function selectStash(sha: string): void {
  setState({ selected: sha });
}

/** 見るのをやめる。コミットや作業ツリーを選んだときに呼ぶ。 */
export function clearStash(): void {
  if (state.selected !== null) setState({ selected: null });
}
