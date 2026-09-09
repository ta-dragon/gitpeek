import { describe, expect, it } from "vitest";

import { ja } from "../i18n/ja";
import {
  branchCsvRows,
  csvExportState,
  csvFileName,
  toCsv,
  type BranchCsvRow,
} from "./branchCsv";
import type { RefEntry } from "./ipc";
import { absoluteTimeDetailed } from "./relativeTime";

function ref(shortName: string, kind: RefEntry["kind"] = "localBranch"): RefEntry {
  const prefix =
    kind === "tag" ? "refs/tags/" : kind === "remoteBranch" ? "refs/remotes/" : "refs/heads/";
  return {
    name: `${prefix}${shortName}`,
    shortName,
    kind,
    target: `sha-${shortName}`,
    upstream: null,
    outOfGraph: false,
    orphan: false,
  };
}

/** 2026-09-01 09:00 JST 前後を適当に。値そのものは比較に使わない。 */
const T = 1_788_000_000;

function times(entries: [string, number][]): Map<string, number> {
  return new Map(entries);
}

/** BOM を外し、CRLF で割った行。 */
function lines(csv: string): string[] {
  expect(csv.startsWith(String.fromCharCode(0xfeff))).toBe(true);
  return csv.slice(1).replace(/\r\n$/, "").split("\r\n");
}

describe("branchCsvRows", () => {
  it("チェックの外れたブランチを落とす", () => {
    const refs = [ref("main"), ref("feature")];
    const rows = branchCsvRows(refs, new Set(["refs/heads/feature"]), times([]));

    expect(rows.map((row) => row.shortName)).toEqual(["main"]);
  });

  it("タグは一覧に入れない", () => {
    // タグにはチェックボックスが無いので、入れると外せない行になる。
    const refs = [ref("main"), ref("v1.0", "tag")];
    const rows = branchCsvRows(refs, new Set(), times([]));

    expect(rows.map((row) => row.shortName)).toEqual(["main"]);
  });

  it("ローカルを先に、その中は名前順で並べる", () => {
    const refs = [
      ref("origin/main", "remoteBranch"),
      ref("zeta"),
      ref("alpha"),
      ref("origin/dev", "remoteBranch"),
    ];
    const rows = branchCsvRows(refs, new Set(), times([]));

    expect(rows.map((row) => row.shortName)).toEqual([
      "alpha",
      "zeta",
      "origin/dev",
      "origin/main",
    ]);
  });

  it("指す先のコミットが読み込まれていなければ時刻は null", () => {
    const rows = branchCsvRows([ref("main"), ref("old")], new Set(), times([["sha-main", T]]));

    expect(rows).toEqual([
      { shortName: "main", time: T },
      { shortName: "old", time: null },
    ]);
  });
});

describe("csvExportState", () => {
  it("0 件なら空だと分かる形で返す", () => {
    // 真偽値にすると、押せない理由が呼び出し側で消える。
    expect(csvExportState([])).toEqual({ kind: "empty" });
  });

  it("件数を持って返す", () => {
    const rows: BranchCsvRow[] = [{ shortName: "main", time: T }];

    expect(csvExportState(rows)).toEqual({ kind: "ready", count: 1 });
  });
});

describe("toCsv", () => {
  it("BOM で始まり、CRLF で終わる", () => {
    // BOM が無いと Excel が CP932 と誤読して日本語のブランチ名が化ける。
    const csv = toCsv([{ shortName: "main", time: T }]);

    expect(csv.startsWith(String.fromCharCode(0xfeff))).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv).not.toContain("\n\n");
  });

  it("見出しの次に 1 行 1 ブランチで並ぶ", () => {
    const csv = toCsv([
      { shortName: "main", time: T },
      { shortName: "dev", time: T },
    ]);

    const rows = lines(csv);
    expect(rows).toHaveLength(3);
    // 文言そのものは見ない（CLAUDE.md §8）。列が 2 つあることだけ固定する。
    expect(rows[0].split(",")).toHaveLength(2);
    expect(rows[1]).toBe(`main,${absoluteTimeDetailed(T)}`);
  });

  it("時刻が無い行は空欄にする", () => {
    // 0 を入れると 1970 年として本物の日時に混ざる。
    const rows = lines(toCsv([{ shortName: "old", time: null }]));

    expect(rows[1]).toBe("old,");
  });

  it("カンマと引用符を含むブランチ名で列がずれない", () => {
    // git はブランチ名に `,` と `"` を許す。囲まないと 1 行が 3 列に見える。
    const rows = lines(toCsv([{ shortName: 'a,b"c', time: null }]));

    expect(rows[1]).toBe('"a,b""c",');
  });

  it("見出しは ja.ts の文言をそのまま使う", () => {
    const rows = lines(toCsv([]));

    expect(rows[0]).toBe(`${ja.refTree.csv.headerName},${ja.refTree.csv.headerTime}`);
  });
});

describe("csvFileName", () => {
  const at = new Date(2026, 8, 9);

  it("日付を後ろに付ける", () => {
    expect(csvFileName("gitviewer", at)).toBe("branches-gitviewer-20260909.csv");
  });

  it("日本語のリポジトリ名は残す", () => {
    // ここを落とすと、登録名が日本語の人は全部同じファイル名になる。
    expect(csvFileName("作業用", at)).toBe("branches-作業用-20260909.csv");
  });

  it("Windows がファイル名に使えない文字を潰す", () => {
    expect(csvFileName('a:b/c\\d*e?f"g<h>i|j', at)).toBe("branches-a-b-c-d-e-f-g-h-i-j-20260909.csv");
  });

  it("潰した結果が空になったらリポジトリ名を落とす", () => {
    expect(csvFileName("///", at)).toBe("branches-20260909.csv");
    expect(csvFileName("", at)).toBe("branches-20260909.csv");
  });
});
