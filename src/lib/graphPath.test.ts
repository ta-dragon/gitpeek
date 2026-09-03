import { describe, expect, it } from "vitest";

import {
  CORNER_RADIUS,
  edgePath,
  graphWidth,
  LANE_COLORS,
  laneColor,
  laneX,
  ROOT_CAP_OFFSET,
  ROOT_CAP_WIDTH,
  rootCapPath,
  rowIndexBySha,
  ROW_HEIGHT,
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

  it("複数レーンをまたぐときは曲がりも横幅ぶん伸ばす", () => {
    // 2 レーン（28px）の移動に 28px の縦を使う。20px 固定にすると水平に見える。
    expect(edgePath(secondParent(0, 2), 0, 3, 2)).toBe(
      "M 12 14 C 12 28 40 28 40 42 L 40 98",
    );
  });

  it("上下どちらでも曲がる辺は 2 回曲がる", () => {
    // 幹から起こしたレーンが、幹に戻る親へ着地する場合。
    expect(edgePath(secondParent(0, 2), 0, 2, 0)).toBe(
      "M 12 14 C 12 28 40 28 40 42 C 40 56 12 56 12 70",
    );
  });

  it("走る余地の無い中間レーンは経由しない", () => {
    // 第 2 親のために起こしたレーンが次の行で終わる形。右へ跳ねてすぐ左へ戻る弧を
    // 描くと飛び出して見えるので、中間レーンを飛ばして直接繋ぐ。
    expect(edgePath(secondParent(0, 2), 0, 1, 0)).toBe("M 12 14 L 12 42");
    // 中間の lane 6 を通らず、lane 1 から lane 0 へ 1 レーンぶん寄るだけになる。
    expect(edgePath(secondParent(1, 6), 0, 1, 0)).toBe(
      "M 26 14 C 26 24 12 24 12 34 L 12 42",
    );
  });

  it("それでも収まらないときは曲がりを縮める", () => {
    // 中間レーンを飛ばしてもなお横幅が縦より大きい。行をはみ出させない。
    const path = edgePath(secondParent(0, 6), 0, 1, 6);
    expect(path).toBe("M 12 14 C 12 28 96 28 96 42");
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

describe("rootCapPath", () => {
  it("ノードの真下に、レーンをまたがない横棒を引く", () => {
    const x = laneX(2);
    const y = rowY(3) + ROOT_CAP_OFFSET;
    expect(rootCapPath(2, 3)).toBe(`M${x - 5} ${y}H${x + 5}`);
  });

  it("横棒は行からはみ出さない", () => {
    // はみ出すと 1 つ下の行の線と重なって、そちらが切れて見える。
    expect(ROOT_CAP_OFFSET + 1).toBeLessThan(ROW_HEIGHT / 2);
  });

  it("横棒はレーン幅に収まる", () => {
    // 隣のレーンに掛かると、その線を横切ったように見える。
    expect(ROOT_CAP_WIDTH).toBeLessThan(14);
  });
});
