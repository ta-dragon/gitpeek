/**
 * フロント側の UI 状態（`state.json` の写し）。
 *
 * 正は `%APPDATA%\com.tatsu.givsoner\state.json`（Rust 側 `store::state`）。
 * **書き込みは Rust 側で 300ms デバウンスされる**ので、ペイン幅のドラッグのような
 * 高頻度の更新でもそのまま呼んでよい。
 */
import { useSyncExternalStore } from "react";

import { loadUiState, saveUiState, type RepositoryUiState, type UiState } from "../lib/ipc";

/** バックエンドから読めるまでの表示用。Rust 側の `Default` 実装と一致させること。 */
export const DEFAULT_UI_STATE: UiState = {
  schemaVersion: 1,
  lastRepositoryId: null,
  windowBounds: null,
  paneRatios: {
    sidebarWidth: 260,
    graphDiffSplit: 0.55,
    reviewDrawerWidth: 420,
  },
  repositoryListSort: "manual",
  perRepository: {},
};

export const DEFAULT_REPOSITORY_UI_STATE: RepositoryUiState = {
  lastOpenedAt: null,
  lastCommitCount: null,
  selectedCommit: null,
  scrollOffset: 0,
  selectedFile: null,
  expandedTreeNodes: [],
  columnWidths: { subject: 600, author: 140, date: 120, sha: 80 },
};

type Snapshot = {
  state: UiState;
  loaded: boolean;
};

let snapshot: Snapshot = { state: DEFAULT_UI_STATE, loaded: false };
const listeners = new Set<() => void>();

function setSnapshot(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUiState(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function currentUiState(): UiState {
  return snapshot.state;
}

let initialized = false;

export async function initUiState(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    setSnapshot({ state: await loadUiState(), loaded: true });
  } catch {
    // 読めなくても既定値で画面は成立する。UI 状態は失っても復元できる。
    setSnapshot({ loaded: true });
  }
}

/** 状態を更新して保存する。保存に失敗しても画面の値は戻さない（次の更新で再試行される）。 */
export function updateUiState(change: (current: UiState) => UiState): void {
  const next = change(snapshot.state);
  setSnapshot({ state: next });
  void saveUiState(next).catch(() => {});
}

/** リポジトリごとの状態を 1 つだけ差し替える。 */
export function updateRepositoryUiState(
  repositoryId: string,
  change: (current: RepositoryUiState) => RepositoryUiState,
): void {
  updateUiState((current) => {
    const existing = current.perRepository[repositoryId] ?? DEFAULT_REPOSITORY_UI_STATE;
    return {
      ...current,
      perRepository: { ...current.perRepository, [repositoryId]: change(existing) },
    };
  });
}
