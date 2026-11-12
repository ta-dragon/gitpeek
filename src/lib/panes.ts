/**
 * ペインを畳む（T-47。docs/DESIGN.md §6.1.1。純関数）。
 *
 * 畳めるのは **左（リポジトリとブランチ）・右（コミット情報）・中央下（差分）** の 3 つ。
 * 畳んだかどうかは `state.json` の `paneRatios` に残し、**幅と比率は触らない**（開けば元に戻る）。
 *
 * **AI レビューのドロワーは畳まない**（閉じるボタンがある。2026-11-12 に利用者が了承）。
 * ドロワーを開いている間は右を畳む操作を受け付けない — 受け付けると、見えないところで旗だけが
 * 変わり、ドロワーを閉じたときに勝手に畳まれて（開いて）見える。
 */
import { ja } from "../i18n/ja";
import type { PaneRatios } from "./ipc";
import { bindingOf, type Action } from "./shortcuts";

export type CollapsiblePane = "sidebar" | "commitInfo" | "diff";

const FIELD = {
  sidebar: "sidebarCollapsed",
  commitInfo: "commitInfoCollapsed",
  diff: "diffCollapsed",
} as const satisfies Record<CollapsiblePane, keyof PaneRatios>;

const ACTION: Record<CollapsiblePane, Action> = {
  sidebar: "toggleSidebar",
  commitInfo: "toggleCommitInfo",
  diff: "toggleDiff",
};

export function isCollapsed(ratios: PaneRatios, pane: CollapsiblePane): boolean {
  return ratios[FIELD[pane]];
}

/** 畳む / 開く。**その 1 つの旗だけを変え、幅と比率は残す。** */
export function setCollapsed(
  ratios: PaneRatios,
  pane: CollapsiblePane,
  collapsed: boolean,
): PaneRatios {
  return { ...ratios, [FIELD[pane]]: collapsed };
}

/**
 * ショートカットで切り替える。**右はドロワーを開いている間は何もしない**（上の説明）。
 * 何もしないときは同じものを返す（呼び出し側が「変わったか」で保存を省ける）。
 */
export function togglePane(
  ratios: PaneRatios,
  pane: CollapsiblePane,
  reviewOpen: boolean,
): PaneRatios {
  if (pane === "commitInfo" && reviewOpen) return ratios;
  return setCollapsed(ratios, pane, !isCollapsed(ratios, pane));
}

/** いま右の列を帯にするか。**ドロワーを開いている間は畳まない。** */
export function commitInfoShownCollapsed(ratios: PaneRatios, reviewOpen: boolean): boolean {
  return ratios.commitInfoCollapsed && !reviewOpen;
}

/** `Enter`（差分へ移る）で、先に差分を開くか。 */
export function opensDiffOnEnter(ratios: PaneRatios): boolean {
  return ratios.diffCollapsed;
}

/** 帯と「畳む」ボタンのツールチップ。**キーは対応表から引く**（一覧とずれない）。 */
export function paneHint(pane: CollapsiblePane, collapsed: boolean): string {
  const name = ja.panes[pane];
  const key = bindingOf(ACTION[pane]).label;
  return collapsed ? ja.panes.expandHint(name, key) : ja.panes.collapseHint(name, key);
}

/** 差分を畳んでいる帯に添える一行。**自動では開かない**ので、何を選んでいるかを出す。 */
export function diffBarDetail(path: string | null): string {
  return path === null ? ja.panes.diffNothing : ja.panes.diffSelected(path);
}
