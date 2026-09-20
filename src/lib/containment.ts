/**
 * ブランチが取り込まれているかを画面に出す（T-38。純関数。docs/DESIGN.md §7.6）。
 *
 * **判定そのものは Rust**（`git/contained.rs`）。ここにあるのは、どの相手で・どのブランチを
 * 調べるか、結果をどう覚えるか、どの印を出すか、だけ。ストア（`store/containment.ts`）と
 * `.tsx` はここを呼ぶだけにする — そうしないとテストが 1 つも当たらない（CLAUDE.md §8）。
 *
 * **グラフとレーンには触らない**（CLAUDE.md §3）。印はブランチ一覧とチップにだけ付ける。
 */
import type { ContainmentOutcome, RefEntry } from "./ipc";

/* ---------- 相手 ---------- */

/** 相手にも調べる対象にもできる ref か。**タグと、読み込んだ履歴の外を指すものは断る**（T-37）。 */
export function isCheckableBranch(entry: RefEntry): boolean {
  return entry.kind !== "tag" && !entry.outOfGraph;
}

/* ---------- 自動で調べるブランチ ---------- */

/**
 * 読み込みのあと自動で調べるブランチ（完全な名前。ref の並び順のまま）。
 *
 * **ローカルブランチだけ**（リモートは onyx で 1,835 本ある。右クリックから 1 本ずつ）。除くもの:
 *
 * - 相手そのもの
 * - **先端が相手と同じ**（調べるまでもない）
 * - 読み込んだ履歴の外 / orphan（共通の祖先が無いので「入っていない」に決まる）
 * - **上流が相手のもの**（`main` と `origin/main` の関係は ahead/behind が既に出している）
 */
export function autoCheckBranches(refs: readonly RefEntry[], target: string | null): string[] {
  if (target === null) return [];
  const targetEntry = refs.find((ref) => ref.name === target);
  if (targetEntry === undefined) return [];

  return refs
    .filter(
      (entry) =>
        entry.kind === "localBranch" &&
        entry.name !== target &&
        entry.target !== targetEntry.target &&
        !entry.outOfGraph &&
        !entry.orphan &&
        entry.upstream !== target,
    )
    .map((entry) => entry.name);
}

/* ---------- 覚え方 ---------- */

/** 調べた結果。**失敗も覚える**（覚えないと、同じブランチを延々と調べ直す）。 */
export type CheckResult =
  | { kind: "done"; outcome: ContainmentOutcome }
  | { kind: "failed"; reason: string };

export type ResultCache = ReadonlyMap<string, CheckResult>;

/**
 * 結果を覚える鍵。**ブランチ名・相手名・両方の先端**の組。
 *
 * どちらかの先端が動けば鍵が変わり、覚えた結果が当たらなくなる（＝調べ直す）。
 * 区切りは空白 — ref 名にも SHA にも空白は入らない。
 */
export function containmentKey(
  branch: string,
  target: string,
  branchTip: string,
  targetTip: string,
): string {
  return [branch, target, branchTip, targetTip].join(" ");
}

/** いまの ref の位置での鍵。どちらかが見つからなければ null。 */
export function keyFor(branch: string, target: string, refs: readonly RefEntry[]): string | null {
  const branchEntry = refs.find((ref) => ref.name === branch);
  const targetEntry = refs.find((ref) => ref.name === target);
  if (branchEntry === undefined || targetEntry === undefined) return null;
  return containmentKey(branch, target, branchEntry.target, targetEntry.target);
}

/** いまの位置で覚えている結果。無ければ（まだ調べていない・どちらかが動いた）null。 */
export function resultFor(
  branch: string,
  target: string | null,
  refs: readonly RefEntry[],
  cache: ResultCache,
): CheckResult | null {
  if (target === null) return null;
  const key = keyFor(branch, target, refs);
  return key === null ? null : (cache.get(key) ?? null);
}

/** 列のうち、まだ結果が当たらない次の 1 本。無ければ null。**消えたブランチは飛ばす。** */
export function nextToCheck(
  queue: readonly string[],
  cache: ResultCache,
  target: string | null,
  refs: readonly RefEntry[],
): string | null {
  if (target === null) return null;
  for (const branch of queue) {
    if (branch === target) continue;
    const key = keyFor(branch, target, refs);
    if (key !== null && !cache.has(key)) return branch;
  }
  return null;
}

/** 進み具合。**消えたブランチは数えない**（分母が減らないと、いつまでも終わらない）。 */
export function checkProgress(
  queue: readonly string[],
  cache: ResultCache,
  target: string | null,
  refs: readonly RefEntry[],
): { done: number; total: number } {
  if (target === null) return { done: 0, total: 0 };
  let done = 0;
  let total = 0;
  for (const branch of new Set(queue)) {
    if (branch === target) continue;
    const key = keyFor(branch, target, refs);
    if (key === null) continue;
    total += 1;
    if (cache.has(key)) done += 1;
  }
  return { done, total };
}

/* ---------- 印 ---------- */

/**
 * 印の出し分け。**`notContained` は印を出さない**（null）。
 *
 * 失敗は `failed` として出す — 黙って印が無いと「入っていない」と読めてしまう。
 */
export type ContainmentView =
  | { mark: "merged" }
  | { mark: "contained"; squash: string | null }
  | { mark: "partial"; upto: number; total: number; squash: string | null }
  | { mark: "changed"; squash: string }
  | { mark: "failed"; reason: string };

export function containmentView(result: CheckResult | null): ContainmentView | null {
  if (result === null) return null;
  if (result.kind === "failed") return { mark: "failed", reason: result.reason };

  const containment = result.outcome.containment;
  switch (containment.kind) {
    case "ancestor":
      return { mark: "merged" };
    case "contained":
      return { mark: "contained", squash: containment.squash };
    case "partial":
      return {
        mark: "partial",
        upto: containment.upto,
        total: containment.total,
        squash: containment.squash,
      };
    case "squashedThenChanged":
      return { mark: "changed", squash: containment.squash };
    case "notContained":
      return null;
  }
}

/** 印から飛べる squash コミット。squash の無い種類は null。 */
export function squashOf(view: ContainmentView | null): string | null {
  if (view === null) return null;
  switch (view.mark) {
    case "contained":
    case "partial":
    case "changed":
      return view.squash;
    case "merged":
    case "failed":
      return null;
  }
}

/**
 * squash コミットへ飛べるか。**相手をグラフから外していて行が無ければ `hidden`**
 * （黙って何も起きないと、壊れたように見える）。
 */
export function squashJump(
  squash: string | null,
  shownShas: ReadonlySet<string>,
): "none" | "hidden" | "go" {
  if (squash === null) return "none";
  return shownShas.has(squash) ? "go" : "hidden";
}

/* ---------- 右クリック ---------- */

/** **押せなくてもメニューから消さない**（CLAUDE.md §6）。理由の文言は `ja.ts`。 */
export type CheckAvailability =
  | { enabled: true; why: null }
  | { enabled: false; why: "tag" | "outOfGraph" | "isTarget" | "noTarget" };

/** 「〈相手〉に入っているか調べる」を押せるか。 */
export function canCheckContainment(
  entry: RefEntry,
  target: string | null,
): CheckAvailability {
  if (entry.kind === "tag") return { enabled: false, why: "tag" };
  if (entry.outOfGraph) return { enabled: false, why: "outOfGraph" };
  if (target === null) return { enabled: false, why: "noTarget" };
  if (entry.name === target) return { enabled: false, why: "isTarget" };
  return { enabled: true, why: null };
}

/** 「このブランチを取り込んでいる可能性があるブランチを調べる…」を押せるか。 */
export function canFindContainers(
  entry: RefEntry,
): { enabled: true; why: null } | { enabled: false; why: "tag" | "outOfGraph" } {
  if (entry.kind === "tag") return { enabled: false, why: "tag" };
  if (entry.outOfGraph) return { enabled: false, why: "outOfGraph" };
  return { enabled: true, why: null };
}

/* ---------- 取り込んでいる可能性があるブランチ（T-38。T-39 を取り込んだ）---------- */

/**
 * 途中経過の出し方。**残りの目安は、ここまでの 1 本あたりの時間 × 残りの本数。**
 *
 * 相手によって重さが違う（祖先関係で決まるものは git を呼ばない）ので、はじめの数本では外れやすい。
 * **1 本も終わっていなければ目安を出さない**（0 で割らない。出た数字が当てにならない）。
 */
export function containersProgressView(
  done: number,
  total: number,
  elapsedMs: number,
): { done: number; total: number; remainingSeconds: number | null } {
  if (done <= 0 || total <= done) return { done, total, remainingSeconds: done >= total && total > 0 ? 0 : null };
  const perOne = elapsedMs / done;
  return { done, total, remainingSeconds: Math.ceil((perOne * (total - done)) / 1000) };
}

/**
 * 届いた途中経過を取り込む。**戻る数字を見せない。**
 *
 * 相手を同時に調べるので、`5 本目まで` の知らせが `6 本目まで` の後に届くことがある。
 * 古い知らせは捨てる（残りの目安も跳ねる）。
 */
export function mergeProgress<T extends { done: number }>(previous: T | null, incoming: T): T {
  if (previous !== null && incoming.done < previous.done) return previous;
  return incoming;
}

/** 結果の見出しの種類。**中止したときは「全部ではない」ことを必ず出す。** */
export type ContainersSummary =
  | { kind: "noCandidates" }
  | { kind: "none"; checked: number }
  | { kind: "found"; count: number; checked: number }
  | { kind: "cancelled"; count: number; checked: number; total: number };

export function containersSummary(search: {
  total: number;
  checked: number;
  found: readonly unknown[];
  cancelled: boolean;
}): ContainersSummary {
  if (search.cancelled) {
    return {
      kind: "cancelled",
      count: search.found.length,
      checked: search.checked,
      total: search.total,
    };
  }
  if (search.total === 0) return { kind: "noCandidates" };
  if (search.found.length === 0) return { kind: "none", checked: search.checked };
  return { kind: "found", count: search.found.length, checked: search.checked };
}

export type ContainerRow = {
  /** 相手の完全な名前。 */
  target: string;
  label: string;
  view: ContainmentView;
  /** 飛べる squash。無ければ null。 */
  squash: string | null;
};

/**
 * 結果の一覧の行。**中身がまるごと入っているものを上に**（全部入っている → 入った後に変更 →
 * マージ済み → 途中まで）。同じ種類の中は Rust の並び（ローカル → リモート、名前順）のまま。
 */
export function containerRows(
  found: readonly ContainmentOutcome[],
  refs: readonly RefEntry[],
): ContainerRow[] {
  const order: Record<ContainmentView["mark"], number> = {
    contained: 0,
    changed: 1,
    merged: 2,
    partial: 3,
    failed: 4,
  };
  const rows: ContainerRow[] = [];
  for (const outcome of found) {
    const view = containmentView({ kind: "done", outcome });
    if (view === null) continue;
    rows.push({ target: outcome.target, label: refLabel(refs, outcome.target), view, squash: squashOf(view) });
  }
  // Array.prototype.sort は安定なので、同じ種類の中の並びは保たれる。
  return rows.sort((a, b) => order[a.view.mark] - order[b.view.mark]);
}

/* ---------- 表示名 ---------- */

/** ref の短い名前（`origin/main`）。一覧に無ければ完全な名前から接頭辞を落とす。 */
export function refLabel(refs: readonly RefEntry[], name: string): string {
  return (
    refs.find((entry) => entry.name === name)?.shortName ??
    name.replace(/^refs\/(heads|remotes|tags)\//, "")
  );
}
