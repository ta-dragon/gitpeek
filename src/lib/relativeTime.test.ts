import { describe, expect, it } from "vitest";

import { absoluteTime, absoluteTimeDetailed, relativeTime } from "./relativeTime";

/** 基準時刻。Unix 秒で 1,800,000,000（2027-01-15 ごろ）。 */
const NOW_SECONDS = 1_800_000_000;
const NOW = NOW_SECONDS * 1000;

/** `NOW` から `seconds` 秒だけ過去の Unix 秒。 */
function ago(seconds: number): number {
  return NOW_SECONDS - seconds;
}

describe("relativeTime", () => {
  it("1 分未満は「たった今」", () => {
    expect(relativeTime(ago(0), NOW)).toBe("たった今");
    expect(relativeTime(ago(59), NOW)).toBe("たった今");
  });

  it("分・時間・日の境界で単位が切り替わる", () => {
    expect(relativeTime(ago(60), NOW)).toBe("1 分前");
    expect(relativeTime(ago(59 * 60), NOW)).toBe("59 分前");
    expect(relativeTime(ago(60 * 60), NOW)).toBe("1 時間前");
    expect(relativeTime(ago(23 * 3600), NOW)).toBe("23 時間前");
    expect(relativeTime(ago(24 * 3600), NOW)).toBe("1 日前");
    expect(relativeTime(ago(3 * 24 * 3600), NOW)).toBe("3 日前");
  });

  it("月・年の境界で単位が切り替わる", () => {
    // 月は暦月ではなく 30 日固定。
    expect(relativeTime(ago(29 * 24 * 3600), NOW)).toBe("29 日前");
    expect(relativeTime(ago(30 * 24 * 3600), NOW)).toBe("1 か月前");
    expect(relativeTime(ago(364 * 24 * 3600), NOW)).toBe("12 か月前");
    expect(relativeTime(ago(365 * 24 * 3600), NOW)).toBe("1 年前");
    expect(relativeTime(ago(3 * 365 * 24 * 3600), NOW)).toBe("3 年前");
  });

  it("未来の日時は「後」で出す", () => {
    // 時計のずれた環境のコミットや rebase 後の author 日時。切り捨てて隠さない。
    expect(relativeTime(NOW_SECONDS + 30, NOW)).toBe("たった今");
    expect(relativeTime(NOW_SECONDS + 5 * 60, NOW)).toBe("5 分後");
    expect(relativeTime(NOW_SECONDS + 2 * 24 * 3600, NOW)).toBe("2 日後");
  });

  it("既定の now は現在時刻", () => {
    expect(relativeTime(Math.floor(Date.now() / 1000))).toBe("たった今");
  });
});

describe("absoluteTime", () => {
  it("ローカル時刻を分まで出す", () => {
    // タイムゾーンに依存しない形で検査する。
    const date = new Date(2026, 8, 3, 6, 12, 34);
    const seconds = Math.floor(date.getTime() / 1000);

    expect(absoluteTime(seconds)).toBe("2026-09-03 06:12");
    expect(absoluteTimeDetailed(seconds)).toBe("2026-09-03 06:12:34");
  });

  it("1 桁の月日時分を 0 で埋める", () => {
    const date = new Date(2026, 0, 5, 4, 7, 9);
    expect(absoluteTime(Math.floor(date.getTime() / 1000))).toBe("2026-01-05 04:07");
  });
});
