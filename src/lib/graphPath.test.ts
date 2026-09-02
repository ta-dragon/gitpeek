import { describe, expect, it } from "vitest";

import {
  CORNER_RADIUS,
  edgePath,
  graphWidth,
  LANE_COLORS,
  laneColor,
  laneX,
  passingPath,
  rowIndexBySha,
  rowY,
  type Edge,
  type GraphRow,
} from "./graphPath";

/** 第一親の辺（同じレーンを予約したまま親の行まで下る）。 */
function firstParent(lane: number): Edge {
  return { fromLane: lane, toLane: lane, parentSha: "p", isMergeSecondParent: false };
}

/** 第 2 親の辺（右に新レーンを起こす）。 */
function secondParent(fromLane: number, toLane: number): Edge {
  return { fromLane, toLane, parentSha: "p", isMergeSecondParent: true };
}

describe("座標", () => {
  it("レーンと行を寸法どおりに座標へ落とす", () => {
    // CLAUDE.md §6 の固定値。行高 28 / レーン幅 14 / 左マージン 12。
    expect(laneX(0)).toBe(12);
    expect(laneX(1)).toBe(26);
    expect(laneX(2)).toBe(40);
    expect(rowY(0)).toBe(14);
    expect(rowY(1)).toBe(42);
  });

  it("グラフ列の幅は maxLane より 1 本ぶん広い", () => {
    // maxLane は 0 起点なので、そのまま掛けると右端のレーンが入らない。
    expect(graphWidth(0)).toBe(26);
    expect(graphWidth(3)).toBe(68);
  });
});

describe("edgePath", () => {
  it("同じレーンなら垂直の直線を引く", () => {
    expect(edgePath(firstParent(0), 0, 1, 0)).toBe("M 12 14 L 12 42");
  });

  it("右へ 1 レーン分岐するときはノードを出てすぐ曲がる", () => {
    // 曲がりは上端。以降は目的のレーンをまっすぐ下る。
    expect(edgePath(secondParent(0, 1), 0, 1, 1)).toBe(
      "M 12 14 C 12 24 26 24 26 34 L 26 42",
    );
  });

  it("左へ 1 レーン合流するときは親のノードの手前で曲がる", () => {
    // 枝の第一親（toLane は予約したままのレーン）で、親は lane 0 に乗る。
    expect(edgePath(firstParent(1), 0, 2, 0)).toBe(
      "M 26 14 L 26 50 C 26 60 12 60 12 70",
    );
  });

  it("複数レーンをまたいでも曲がりは 1 回だけ", () => {
    expect(edgePath(secondParent(0, 2), 0, 3, 2)).toBe(
      "M 12 14 C 12 24 40 24 40 34 L 40 98",
    );
  });

  it("上下どちらでも曲がる辺は 2 回曲がる", () => {
    // 幹から起こしたレーンが、幹に戻る親へ着地する場合。
    expect(edgePath(secondParent(0, 2), 0, 2, 0)).toBe(
      "M 12 14 C 12 24 40 24 40 34 L 40 50 C 40 60 12 60 12 70",
    );
  });

  it("行が詰まっているときは角丸を縮めて直線部分を捨てる", () => {
    // 1 行のあいだに 2 回曲がるので、角丸は CORNER_RADIUS * 2 に届かない。
    const path = edgePath(secondParent(0, 2), 0, 1, 0);
    expect(path).toBe("M 12 14 C 12 21 40 21 40 28 C 40 35 12 35 12 42");
    expect(path).not.toContain(" L ");
  });

  it("同一行の辺は直線にする", () => {
    // topo-order では起こらないが、描けずに消えるより直線を引く。
    expect(edgePath(secondParent(0, 1), 0, 0, 1)).toBe("M 12 14 L 26 14");
  });

  it("角丸は 8〜12px の範囲に収める", () => {
    expect(CORNER_RADIUS).toBeGreaterThanOrEqual(8);
    expect(CORNER_RADIUS).toBeLessThanOrEqual(12);
  });
});

describe("passingPath", () => {
  it("行の上端から下端まで通す", () => {
    // ノードの中心ではなく行の境界まで引く。行をまたいで線が途切れないように。
    expect(passingPath(1, 2)).toBe("M 26 56 L 26 84");
  });
});

describe("laneColor", () => {
  it("lane 0 は幹の固定色", () => {
    expect(laneColor(0)).toBe("var(--graph-lane-trunk)");
  });

  it("lane 1 以降は 8 色をローテーションする", () => {
    expect(laneColor(1)).toBe("var(--graph-lane-0)");
    expect(laneColor(8)).toBe("var(--graph-lane-7)");
    expect(laneColor(9)).toBe(laneColor(1));
    expect(laneColor(1 + LANE_COLORS * 3)).toBe(laneColor(1));
  });

  it("幹の色は他のどのレーンにも割り当てない", () => {
    for (let lane = 1; lane <= 32; lane += 1) {
      expect(laneColor(lane)).not.toBe(laneColor(0));
    }
  });
});

describe("rowIndexBySha", () => {
  it("SHA から行番号を引ける", () => {
    const rows: GraphRow[] = [
      { sha: "a", lane: 0, passing: [], edges: [] },
      { sha: "b", lane: 1, passing: [0], edges: [] },
    ];

    const index = rowIndexBySha(rows);
    expect(index.get("a")).toBe(0);
    expect(index.get("b")).toBe(1);
    expect(index.get("zz")).toBeUndefined();
  });
});
