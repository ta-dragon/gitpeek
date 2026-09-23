/**
 * ファイルを変えたコミットを辿る（T-40。docs/DESIGN.md §6.7）の受け渡し。
 *
 * 右クリックは変更ファイル一覧（右の列）で押されるが、探す欄はコミットリストにあり、
 * 辿った名前を使ってファイルを選び直すのは `App.tsx` なので、props で配らずにここへ置く
 * （`store/containment.ts` と同じ作り）。**判断は `lib/fileHistory.ts` の純関数。**
 */
import { useSyncExternalStore } from "react";

export type FileHistoryState = {
  /** 右クリックで頼まれた検索。**`nonce` が変わったときだけ動く**（同じファイルを 2 度押しても探す）。 */
  request: { repositoryId: string; input: string; nonce: number } | null;
  /** いまの検索が辿った名前。ファイルで探していなければ空。 */
  followed: { repositoryId: string; names: readonly string[] };
};

let state: FileHistoryState = {
  request: null,
  followed: { repositoryId: "", names: [] },
};

const listeners = new Set<() => void>();

function setState(next: Partial<FileHistoryState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFileHistory(): FileHistoryState {
  return useSyncExternalStore(subscribe, () => state);
}

/** 探す欄にこの文字を入れて探すよう頼む。 */
export function requestFileHistory(repositoryId: string, input: string): void {
  setState({ request: { repositoryId, input, nonce: (state.request?.nonce ?? 0) + 1 } });
}

/** コミットリストが、いまの検索で辿った名前を知らせる。**変わらなければ知らせない。** */
export function publishFollowed(repositoryId: string, names: readonly string[]): void {
  const current = state.followed;
  if (
    current.repositoryId === repositoryId &&
    current.names.length === names.length &&
    current.names.every((name, index) => name === names[index])
  ) {
    return;
  }
  setState({ followed: { repositoryId, names } });
}
