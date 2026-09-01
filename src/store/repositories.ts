/**
 * フロント側のリポジトリ状態。
 *
 * 登録の正は `settings.json` の `repositories`（Rust 側 `store::settings`）、
 * 選択中と最終アクセス時刻は `state.json` 側にある。
 * このモジュールは両者をまとめ、画面からは 1 つの状態として見えるようにする。
 */
import { useSyncExternalStore } from "react";

import {
  addRepository,
  listRepositories,
  removeRepository,
  scanRepositories,
  type RepositoryEntry,
} from "../lib/ipc";
import { refreshSettings, updateSettings } from "./settings";
import { currentUiState, updateRepositoryUiState, updateUiState } from "./uiState";

type Snapshot = {
  entries: RepositoryEntry[];
  /** 選択中のリポジトリ ID。未選択なら null。 */
  selectedId: string | null;
  loaded: boolean;
  busy: boolean;
  error: string | null;
};

let snapshot: Snapshot = {
  entries: [],
  selectedId: null,
  loaded: false,
  busy: false,
  error: null,
};

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

export function useRepositories(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function selectedRepository(): RepositoryEntry | null {
  return snapshot.entries.find((entry) => entry.id === snapshot.selectedId) ?? null;
}

/** 一覧を並べ替える。`state.json` の `repositoryListSort` に従う。 */
export function sortedEntries(
  entries: RepositoryEntry[],
  mode: "manual" | "recent",
): RepositoryEntry[] {
  const sorted = [...entries];
  if (mode === "recent") {
    const perRepository = currentUiState().perRepository;
    // 一度も開いていないものは末尾へ。
    sorted.sort((a, b) => {
      const left = perRepository[a.id]?.lastOpenedAt ?? "";
      const right = perRepository[b.id]?.lastOpenedAt ?? "";
      return right.localeCompare(left);
    });
  } else {
    sorted.sort((a, b) => a.order - b.order);
  }
  return sorted;
}

let initialized = false;

/**
 * 起動時に 1 度だけ呼ぶ。
 *
 * `state.json` の `lastRepositoryId` を復元するが、**パスが消えていれば選択しない**
 * （docs/DESIGN.md §13.1）。一覧にはグレーアウトして残る。
 */
export async function initRepositories(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await refresh();

  const lastId = currentUiState().lastRepositoryId;
  const last = snapshot.entries.find((entry) => entry.id === lastId);
  if (last && last.probe !== null) {
    setSnapshot({ selectedId: last.id });
  }
}

/** 登録内容を読み直す。追加・削除・再指定のあとに呼ぶ。 */
export async function refresh(): Promise<void> {
  try {
    const entries = await listRepositories();
    const selectedId =
      snapshot.selectedId !== null &&
      entries.some((entry) => entry.id === snapshot.selectedId)
        ? snapshot.selectedId
        : null;
    setSnapshot({ entries, selectedId, loaded: true, error: null });
  } catch (error) {
    setSnapshot({ loaded: true, error: messageOf(error) });
  }
}

export function select(id: string | null): void {
  setSnapshot({ selectedId: id });
  updateUiState((current) => ({ ...current, lastRepositoryId: id }));
  if (id !== null) {
    updateRepositoryUiState(id, (current) => ({
      ...current,
      lastOpenedAt: new Date().toISOString(),
    }));
  }
}

/** フォルダを 1 つ登録して選択する。既に登録済みならそれを選ぶだけ。 */
export async function add(path: string): Promise<void> {
  await withBusy(async () => {
    const added = await addRepository(path);
    await Promise.all([refresh(), refreshSettings()]);
    select(added.id);
  });
}

/**
 * フォルダ配下をスキャンして見つかったものをまとめて登録する。
 * 登録した件数を返す（0 件のときの文言を呼び出し側が出し分けるため）。
 */
export async function scanAndAdd(root: string): Promise<number> {
  let added = 0;
  await withBusy(async () => {
    const found = await scanRepositories(root);
    for (const path of found) {
      await addRepository(path);
      added += 1;
    }
    await Promise.all([refresh(), refreshSettings()]);
  });
  return added;
}

/** 登録を解除する。**フォルダには触らない。** */
export async function remove(id: string): Promise<void> {
  await withBusy(async () => {
    await removeRepository(id);
    if (snapshot.selectedId === id) {
      select(null);
    }
    await Promise.all([refresh(), refreshSettings()]);
  });
}

/** 消えたリポジトリのパスを差し替える。ID を保つので UI 状態も引き継がれる。 */
export async function relocate(id: string, path: string): Promise<void> {
  await withBusy(async () => {
    await updateSettings((current) => ({
      ...current,
      repositories: current.repositories.map((repository) =>
        repository.id === id ? { ...repository, path } : repository,
      ),
    }));
    await refresh();
  });
}

/** 手動並べ替えの結果を `settings.json` の `order` に書く。 */
export async function reorder(orderedIds: string[]): Promise<void> {
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  await updateSettings((current) => ({
    ...current,
    repositories: current.repositories.map((repository) => ({
      ...repository,
      order: rank.get(repository.id) ?? repository.order,
    })),
  }));

  // 画面の順序をすぐ合わせる。probe をやり直す必要は無いので再取得はしない。
  setSnapshot({
    entries: snapshot.entries.map((entry) => ({
      ...entry,
      order: rank.get(entry.id) ?? entry.order,
    })),
  });
}

async function withBusy(work: () => Promise<void>): Promise<void> {
  setSnapshot({ busy: true, error: null });
  try {
    await work();
  } catch (error) {
    setSnapshot({ error: messageOf(error) });
  } finally {
    setSnapshot({ busy: false });
  }
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : String(error);
}
