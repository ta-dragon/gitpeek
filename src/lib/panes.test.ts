import { describe, expect, it } from "vitest";

import type { PaneRatios } from "./ipc";
import {
  commitInfoShownCollapsed,
  diffBarDetail,
  isCollapsed,
  opensDiffOnEnter,
  paneHint,
  setCollapsed,
  togglePane,
} from "./panes";
import { bindingOf } from "./shortcuts";

// 文言そのものは assert しない（CLAUDE.md §8）。見るのは旗の動きと、キーが一覧と同じこと。

const open: PaneRatios = {
  sidebarWidth: 300,
  graphDiffSplit: 0.4,
  commitInfoWidth: 360,
  reviewDrawerWidth: 420,
  sidebarCollapsed: false,
  commitInfoCollapsed: false,
  diffCollapsed: false,
};

describe("togglePane / setCollapsed", () => {
  it("その 1 つの旗だけを変え、幅と比率は残す（開けば元に戻る）", () => {
    const folded = togglePane(open, "sidebar", false);
    expect(folded).toEqual({ ...open, sidebarCollapsed: true });
    expect(togglePane(folded, "sidebar", false)).toEqual(open);

    const diff = togglePane(open, "diff", false);
    expect(diff.diffCollapsed).toBe(true);
    expect(diff.graphDiffSplit).toBe(0.4);
  });

  it("右はドロワーを開いている間は切り替えない（見えないところで旗が変わらない）", () => {
    expect(togglePane(open, "commitInfo", true)).toBe(open);
    expect(togglePane(open, "commitInfo", false).commitInfoCollapsed).toBe(true);
  });

  it("ドロワーを開いていても、左と中央下は切り替わる", () => {
    expect(togglePane(open, "sidebar", true).sidebarCollapsed).toBe(true);
    expect(togglePane(open, "diff", true).diffCollapsed).toBe(true);
  });

  it("ボタンからは明示した向きにする", () => {
    expect(isCollapsed(setCollapsed(open, "commitInfo", true), "commitInfo")).toBe(true);
    expect(isCollapsed(setCollapsed(open, "commitInfo", false), "commitInfo")).toBe(false);
  });
});

describe("commitInfoShownCollapsed", () => {
  it("畳んでいても、ドロワーを開いている間はドロワーを出す", () => {
    const folded = setCollapsed(open, "commitInfo", true);
    expect(commitInfoShownCollapsed(folded, false)).toBe(true);
    expect(commitInfoShownCollapsed(folded, true)).toBe(false);
    expect(commitInfoShownCollapsed(open, false)).toBe(false);
  });
});

describe("opensDiffOnEnter", () => {
  it("差分を畳んでいるときだけ、Enter で先に開く", () => {
    expect(opensDiffOnEnter(setCollapsed(open, "diff", true))).toBe(true);
    expect(opensDiffOnEnter(open)).toBe(false);
  });
});

describe("paneHint / diffBarDetail", () => {
  it("ツールチップのキーは対応表と同じ", () => {
    expect(paneHint("sidebar", false)).toContain(bindingOf("toggleSidebar").label);
    expect(paneHint("commitInfo", true)).toContain(bindingOf("toggleCommitInfo").label);
    expect(paneHint("diff", true)).toContain(bindingOf("toggleDiff").label);
  });

  it("畳むときと開くときで言い方が違う", () => {
    expect(paneHint("diff", true)).not.toBe(paneHint("diff", false));
  });

  it("差分の帯には、選んでいるファイルを出す", () => {
    expect(diffBarDetail("src/a.ts")).toContain("src/a.ts");
    expect(diffBarDetail(null)).not.toContain("null");
  });
});
