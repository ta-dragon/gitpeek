/**
 * 選択中リポジトリのグラフ素材。
 *
 * 正は Rust 側（`git::snapshot`）で、こちらは**表示用の写しを 1 つだけ**持つ。
 * リポジトリ選択時に全コミットを一括で受け取る設計なので（docs/DESIGN.md §4.1）、
 * ここに複数リポジトリ分を溜めない。直前のリポジトリのキャッシュは Rust 側の LRU。
 */
import { useSyncExternalStore } from "react";

import {
  ALL_REFS,
  computeBranchStatus,
  computeLaneLayout,
  loadRepositorySnapshot,
  onSnapshotProgress,
  type BranchStatus,
  type GraphOrder,
  type LaneLayout,
  type RepositorySnapshot,
  type SnapshotProgress,
  type VisibleRefs,
} from "../lib/ipc";
import { currentUiState, updateRepositoryUiState } from "./uiState";

/**
 * 自動で読み込まない大きさの境目。
 *
 * docs/DESIGN.md §4.1 が「10 万コミット超は v1 では非対象」と決めている
 * （恒久的な非対象ではない。100 万コミット級の正式対応は v1.1 以降）。
 * 非対象の規模を**起動時に黙って読みに行くと、数十秒操作できないうえ落ちることがある**
 * （148 万コミットで Rust 側 3.5GB / WebView2 側 3.2GB まで伸び、プロセスが消えた）。
 * 前回の件数が分かっているものだけ、読み込む前に確認を挟む。
 */
export const LARGE_REPOSITORY_COMMITS = 100_000;

export type SnapshotState = {
  /** `data` がどのリポジトリのものか。選択と食い違った表示を防ぐ。 */
  repositoryId: string | null;
  data: RepositorySnapshot | null;
  /**
   * 描画用のレーン。`data` と同じリポジトリ・同じ並び順のものだけを持つ。
   * レーン計算に失敗しても履歴の要約は出したいので、`data` とは別に持つ。
   */
  layout: LaneLayout | null;
  /** 表示中の並び順（docs/DESIGN.md §4.3）。切替は `git log` を再実行しない。 */
  order: GraphOrder;
  /**
   * グラフに出す ref（docs/DESIGN.md §4.4）。絞ると行と線が実際に減る。
   * 正は `settings.json` の側で、ここに持つのは表示中の写し。
   */
  visibleRefs: VisibleRefs;
  /**
   * 上流を持つローカルブランチの ahead/behind（docs/DESIGN.md §4.5）。
   * 可視 ref とは無関係なので、絞り込みでは引き直さない。
   */
  branchStatus: BranchStatus[];
  loading: boolean;
  error: string | null;
  /**
   * 取得にかかった時間。git の所要時間そのものではなく、IPC 込みの往復。
   * キャッシュが効くと `git log` を跨がないので極端に短くなる。
   */
  elapsedMs: number | null;
  /** 読み込み中の途中経過。届いていなければ null。 */
  progress: SnapshotProgress | null;
  /**
   * 大きすぎて自動では読まなかったときの、前回の件数。
   * 利用者が明示的に読み込みを選ぶまで `data` は空のまま。
   */
  oversized: number | null;
};

/** 参照が毎回変わるとツリーが毎回組み直しになる。空のときは同じ配列を使う。 */
const NO_BRANCH_STATUS: BranchStatus[] = [];

let snapshot: SnapshotState = {
  repositoryId: null,
  data: null,
  layout: null,
  order: "topo",
  visibleRefs: ALL_REFS,
  branchStatus: NO_BRANCH_STATUS,
  loading: false,
  error: null,
  elapsedMs: null,
  progress: null,
  oversized: null,
};

// Rust 側から届く途中経過を拾う。購読は 1 回だけで、以降は現在の読み込み対象の
// ものだけを採る（切替後に前のリポジトリの進捗が遅れて届くため）。
void onSnapshotProgress((progress) => {
  if (!snapshot.loading || progress.repositoryId !== snapshot.repositoryId) return;
  setSnapshot({ progress });
});

const listeners = new Set<() => void>();

function setSnapshot(next: Partial<SnapshotState>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSnapshot(): SnapshotState {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/**
 * 直近の要求だけを採用するための番号。
 *
 * 数万コミットの読み込みは数百 ms かかるので、素早く切り替えると先の要求が
 * 後から返ってくる。番号が古い応答は捨てる。
 */
let latestRequest = 0;

/**
 * 選択中リポジトリの履歴を読む。`id` が null なら表示を空にする。
 *
 * `confirmed` は「大きくても読む」と利用者が選んだとき。前回の件数が
 * [`LARGE_REPOSITORY_COMMITS`] を超えるリポジトリは、これが無いと読みに行かない。
 */
export async function load(
  id: string | null,
  force = false,
  confirmed = false,
  visibleRefs?: VisibleRefs,
): Promise<void> {
  // StrictMode の二重実行や、同じ行の連打で 2 度読みに行かない。
  if (!force && id !== null && id === snapshot.repositoryId && snapshot.loading) return;

  // 可視 ref はリポジトリごとの設定。渡されなければ、同じリポジトリの読み直しなら
  // 今の絞り込みを保ち、切り替えなら全表示に戻す。
  const visible =
    visibleRefs ?? (id === snapshot.repositoryId ? snapshot.visibleRefs : ALL_REFS);

  const request = (latestRequest += 1);

  if (id === null) {
    setSnapshot({
      repositoryId: null,
      data: null,
      layout: null,
      branchStatus: NO_BRANCH_STATUS,
      loading: false,
      error: null,
      elapsedMs: null,
      progress: null,
      oversized: null,
    });
    return;
  }

  // 前回の件数を割合表示の分母にする。取得内容には影響しない。
  const estimate = currentUiState().perRepository[id]?.lastCommitCount ?? null;

  // 前回が大きすぎたリポジトリは、起動時や切替で黙って読みに行かない。
  if (!confirmed && estimate !== null && estimate > LARGE_REPOSITORY_COMMITS) {
    setSnapshot({
      repositoryId: id,
      data: null,
      layout: null,
      branchStatus: NO_BRANCH_STATUS,
      loading: false,
      error: null,
      elapsedMs: null,
      progress: null,
      oversized: estimate,
    });
    return;
  }

  setSnapshot({
    repositoryId: id,
    data: null,
    layout: null,
    visibleRefs: visible,
    branchStatus: NO_BRANCH_STATUS,
    loading: true,
    error: null,
    elapsedMs: null,
    progress: null,
    oversized: null,
  });
  const started = performance.now();

  try {
    const data = await loadRepositorySnapshot(id, force, estimate);
    if (request !== latestRequest) return;

    // レーンは Rust 側のキャッシュから作られるので `git log` は走らない。
    // ここで失敗しても履歴の要約は出せるよう、グラフだけ諦める。
    const layout = await layoutOrNull(id, visible, snapshot.order);
    if (request !== latestRequest) return;

    setSnapshot({
      repositoryId: id,
      data,
      layout,
      branchStatus: NO_BRANCH_STATUS,
      loading: false,
      error: null,
      elapsedMs: Math.round(performance.now() - started),
      progress: null,
      oversized: null,
    });
    // 次回の分母を更新する。件数が変わっても割合が大きく狂わないように毎回書く。
    updateRepositoryUiState(id, (current) => ({
      ...current,
      lastCommitCount: data.commits.length,
    }));

    // ahead/behind はグラフを出すのに要らない。待たせずに後から埋める。
    const status = await branchStatusOrEmpty(id);
    if (request !== latestRequest) return;
    setSnapshot({ branchStatus: status });
  } catch (error) {
    if (request !== latestRequest) return;
    // 読めなくても一覧と切替は使えるままにする。空状態には落とさない。
    setSnapshot({
      repositoryId: id,
      data: null,
      layout: null,
      branchStatus: NO_BRANCH_STATUS,
      loading: false,
      error: messageOf(error),
      progress: null,
      oversized: null,
    });
  }
}

/**
 * 並び順を切り替える。**`git log` は再実行しない**（docs/DESIGN.md §4.3）。
 * Rust 側がメモリ上で並べ替えてレーンを振り直すだけなので数十 ms で返る。
 */
export async function setOrder(order: GraphOrder): Promise<void> {
  if (order === snapshot.order) return;
  const id = snapshot.repositoryId;
  setSnapshot({ order });
  if (id === null || snapshot.data === null) return;

  const request = (latestRequest += 1);
  const layout = await layoutOrNull(id, snapshot.visibleRefs, order);
  if (request !== latestRequest) return;
  setSnapshot({ layout });
}

/**
 * グラフに出す ref を絞り直す（docs/DESIGN.md §4.4）。
 *
 * `git log` は走らない。Rust 側が到達可能集合を計算し直してレーンを振り直すだけ。
 * **永続化は呼び出し側の責務**（`settings.json` の `repositories[].visibleRefs`）。
 */
export async function setVisibleRefs(visibleRefs: VisibleRefs): Promise<void> {
  const id = snapshot.repositoryId;
  setSnapshot({ visibleRefs });
  if (id === null || snapshot.data === null) return;

  const request = (latestRequest += 1);
  const layout = await layoutOrNull(id, visibleRefs, snapshot.order);
  if (request !== latestRequest) return;
  setSnapshot({ layout });
}

/**
 * ahead/behind を数える。失敗しても数値を出さないだけに留める。
 *
 * `git rev-list` は走らない（メモリ上のグラフから数える — CLAUDE.md §2）ので、
 * 読み込みの直後に呼んでもプロセスは増えない。
 */
async function branchStatusOrEmpty(id: string): Promise<BranchStatus[]> {
  try {
    const status = await computeBranchStatus(id);
    return status.length === 0 ? NO_BRANCH_STATUS : status;
  } catch {
    return NO_BRANCH_STATUS;
  }
}

/** レーンを引く。失敗はグラフを出さないだけに留める。 */
async function layoutOrNull(
  id: string,
  visibleRefs: VisibleRefs,
  order: GraphOrder,
): Promise<LaneLayout | null> {
  try {
    return await computeLaneLayout(id, visibleRefs, order);
  } catch {
    return null;
  }
}

/** 今どのリポジトリの履歴を持っているか。購読していない場所から読む用。 */
export function currentRepositoryId(): string | null {
  return snapshot.repositoryId;
}

/** 表示中のリポジトリを読み直す。fetch / checkout の後に使う（T-17 / T-18）。 */
export function reload(): Promise<void> {
  return load(snapshot.repositoryId, true, true);
}

/** 大きさの確認を経て読み込む。 */
export function loadAnyway(): Promise<void> {
  return load(snapshot.repositoryId, false, true);
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : String(error);
}
