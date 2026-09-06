import { describe, expect, it } from "vitest";

import {
  allWordSegments,
  buildRows,
  formatBytes,
  measureDiff,
  rowIndexForLine,
  shouldCollapse,
  utf8Length,
} from "./diffRows";
import { DEFAULT_SETTINGS, type DiffLine, type DiffLineKind, type Hunk } from "./ipc";

function line(kind: DiffLineKind, text: string): DiffLine {
  return { kind, text, oldLine: null, newLine: null, ending: "lf" };
}

function hunkOf(lines: DiffLine[], heading = ""): Hunk {
  return { oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, heading, lines };
}

/** 行の種類だけを並べる（`@` は hunk の見出し）。 */
function kinds(rows: ReturnType<typeof buildRows>): string[] {
  return rows.map((row) => {
    if (row.kind === "hunk") return "@";
    if (row.kind === "single") return row.line.text;
    return `${row.left?.text ?? "."}|${row.right?.text ?? "."}`;
  });
}

describe("buildRows", () => {
  it("hunk の見出しを行リストに含める", () => {
    const rows = buildRows([hunkOf([line("context", "a")]), hunkOf([line("context", "b")])], "unified");
    expect(kinds(rows)).toEqual(["@", "a", "@", "b"]);
  });

  it("unified は hunk の行をそのまま並べる", () => {
    const rows = buildRows([hunkOf([line("removed", "a"), line("added", "A")])], "unified");
    expect(kinds(rows)).toEqual(["@", "a", "A"]);
  });

  it("side-by-side は左右に対応付ける（余りは空欄）", () => {
    const rows = buildRows(
      [hunkOf([line("removed", "a"), line("added", "A"), line("added", "B")])],
      "side-by-side",
    );
    expect(kinds(rows)).toEqual(["@", "a|A", ".|B"]);
  });

  it("hunk が無ければ行も無い", () => {
    expect(buildRows([], "side-by-side")).toEqual([]);
  });
});

describe("rowIndexForLine", () => {
  /** 行番号付きの行。**変更後の行番号で引く。** */
  function numbered(kind: DiffLineKind, text: string, oldLine: number | null, newLine: number | null): DiffLine {
    return { kind, text, oldLine, newLine, ending: "lf" };
  }

  const hunk = hunkOf([
    numbered("context", "a", 10, 10),
    numbered("removed", "b", 11, null),
    numbered("added", "B", null, 11),
    numbered("context", "c", 12, 12),
  ]);

  it("unified で行を見つける（hunk の見出しのぶんずれない）", () => {
    const rows = buildRows([hunk], "unified");
    // ["@", a, b, B, c] なので 11 行目（B）は索引 3。
    expect(rowIndexForLine(rows, 11)).toBe(3);
    expect(rowIndexForLine(rows, 10)).toBe(1);
  });

  it("side-by-side では右側の行番号で引く", () => {
    const rows = buildRows([hunk], "side-by-side");
    const index = rowIndexForLine(rows, 11);
    expect(index).not.toBeNull();
    const row = rows[index ?? 0];
    expect(row.kind).toBe("pair");
    expect(row.kind === "pair" ? row.right?.newLine : null).toBe(11);
  });

  // **削除された行しか無い場所へは飛べない**（変更後の行番号を持たない）。
  it("削除された行だけの行番号は当たらない", () => {
    const rows = buildRows([hunk], "unified");
    // 削除行の変更前の行番号（11）を持つ行は右側に無い ＝ 「B」の索引が返る。
    // 変更後に存在しない行番号は null。
    expect(rowIndexForLine(rows, 99)).toBeNull();
  });

  // 端の値: 行が 1 つも無い / 0 と負の行番号。
  it("行が無い・あり得ない行番号では null", () => {
    expect(rowIndexForLine([], 1)).toBeNull();
    const rows = buildRows([hunk], "unified");
    expect(rowIndexForLine(rows, 0)).toBeNull();
    expect(rowIndexForLine(rows, -1)).toBeNull();
  });

  it("複数の hunk をまたいで探す", () => {
    const second = hunkOf([numbered("added", "z", null, 40)]);
    const rows = buildRows([hunk, second], "unified");
    expect(rowIndexForLine(rows, 40)).toBe(rows.length - 1);
  });
});

describe("allWordSegments", () => {
  it("hunk をまたいでも 1 つの表に畳む", () => {
    const first = hunkOf([line("removed", "abc"), line("added", "abd")]);
    const second = hunkOf([line("removed", "xyz"), line("added", "xyZ")]);

    const segments = allWordSegments([first, second]);

    expect(segments.get(first.lines[0])).toEqual([
      { text: "ab", changed: false },
      { text: "c", changed: true },
    ]);
    expect(segments.get(second.lines[1])).toEqual([
      { text: "xy", changed: false },
      { text: "Z", changed: true },
    ]);
  });
});

describe("utf8Length", () => {
  it("ASCII は 1 文字 1 バイト", () => {
    expect(utf8Length("abc")).toBe(3);
  });

  it("日本語は 1 文字 3 バイト（length で代用すると 3 分の 1 に見える）", () => {
    expect("日本語".length).toBe(3);
    expect(utf8Length("日本語")).toBe(9);
  });

  it("サロゲートペアは 2 つで 4 バイト", () => {
    expect("𩸽".length).toBe(2);
    expect(utf8Length("𩸽")).toBe(4);
  });

  it("空文字は 0", () => {
    expect(utf8Length("")).toBe(0);
  });
});

describe("measureDiff", () => {
  it("行数とバイト数を数える", () => {
    const size = measureDiff([
      hunkOf([line("context", "abc"), line("added", "日本")]),
      hunkOf([line("removed", "x")]),
    ]);

    expect(size).toEqual({ lines: 3, bytes: 3 + 6 + 1 });
  });
});

describe("shouldCollapse", () => {
  const ui = { ...DEFAULT_SETTINGS.ui, collapseLines: 10, collapseBytes: 100 };

  it("どちらも下回れば開く", () => {
    expect(shouldCollapse({ lines: 10, bytes: 100 }, ui)).toBe(false);
  });

  it("行数だけ超えても折りたたむ", () => {
    expect(shouldCollapse({ lines: 11, bytes: 1 }, ui)).toBe(true);
  });

  // 1 行が極端に長いファイル（minify 済みなど）は行数では引っかからない。
  it("バイト数だけ超えても折りたたむ", () => {
    expect(shouldCollapse({ lines: 1, bytes: 101 }, ui)).toBe(true);
  });
});

describe("formatBytes", () => {
  it("1KB 未満は実数のまま出す", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("1024 区切りで単位を上げる", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it("10 以上は小数を出さない", () => {
    expect(formatBytes(1024 * 15)).toBe("15 KB");
  });
});
