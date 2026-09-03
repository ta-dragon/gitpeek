import { describe, expect, it } from "vitest";

import { pairHunk, wordDiff, wordSegments } from "./diffView";
import type { DiffLine, DiffLineKind, Hunk } from "./ipc";

function line(kind: DiffLineKind, text: string, oldLine: number | null, newLine: number | null): DiffLine {
  return { kind, text, oldLine, newLine, ending: "lf" };
}

function hunkOf(lines: DiffLine[]): Hunk {
  return { oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, heading: "", lines };
}

/** 行を `-b|+B` のように潰す（`.` は空欄）。 */
function shape(rows: ReturnType<typeof pairHunk>): string[] {
  const side = (value: DiffLine | null): string => (value === null ? "." : value.text);
  return rows.map((row) => `${side(row.left)}|${side(row.right)}`);
}

describe("pairHunk", () => {
  it("変わっていない行は左右に同じ行を置く", () => {
    const rows = pairHunk(hunkOf([line("context", "a", 1, 1), line("context", "b", 2, 2)]));
    expect(shape(rows)).toEqual(["a|a", "b|b"]);
  });

  it("削除と追加が同数なら 1 対 1 で並べる", () => {
    const rows = pairHunk(
      hunkOf([
        line("context", "a", 1, 1),
        line("removed", "b", 2, null),
        line("removed", "c", 3, null),
        line("added", "B", null, 2),
        line("added", "C", null, 3),
      ]),
    );

    expect(shape(rows)).toEqual(["a|a", "b|B", "c|C"]);
  });

  it("数が違えば余りを空欄にする", () => {
    const rows = pairHunk(
      hunkOf([
        line("removed", "b", 1, null),
        line("added", "B", null, 1),
        line("added", "C", null, 2),
        line("added", "D", null, 3),
      ]),
    );

    expect(shape(rows)).toEqual(["b|B", ".|C", ".|D"]);
  });

  it("追加だけの hunk は左が全部空欄", () => {
    const rows = pairHunk(hunkOf([line("added", "x", null, 1), line("added", "y", null, 2)]));
    expect(shape(rows)).toEqual([".|x", ".|y"]);
  });

  it("削除だけの hunk は右が全部空欄", () => {
    const rows = pairHunk(hunkOf([line("removed", "x", 1, null), line("removed", "y", 2, null)]));
    expect(shape(rows)).toEqual(["x|.", "y|."]);
  });

  it("変更の塊がコンテキストで区切られる", () => {
    const rows = pairHunk(
      hunkOf([
        line("removed", "a", 1, null),
        line("added", "A", null, 1),
        line("context", "x", 2, 2),
        line("removed", "b", 3, null),
        line("added", "B", null, 3),
      ]),
    );

    expect(shape(rows)).toEqual(["a|A", "x|x", "b|B"]);
  });

  it("空欄には行番号が無い", () => {
    const rows = pairHunk(hunkOf([line("added", "x", null, 1)]));
    expect(rows[0].left).toBeNull();
    expect(rows[0].right?.newLine).toBe(1);
  });
});

describe("wordDiff", () => {
  it("末尾だけが違う", () => {
    const diff = wordDiff("const value = 1;", "const value = 2;");
    expect(diff.left).toEqual([
      { text: "const value = ", changed: false },
      { text: "1", changed: true },
      { text: ";", changed: false },
    ]);
    expect(diff.right[1]).toEqual({ text: "2", changed: true });
  });

  it("先頭だけが違う", () => {
    const diff = wordDiff("let x = longEnoughValue;", "const x = longEnoughValue;");
    // 共通の末尾は "t x = longEnoughValue;" なので、残るのは "le" と "cons"。
    expect(diff.left[0]).toEqual({ text: "le", changed: true });
    expect(diff.right[0]).toEqual({ text: "cons", changed: true });
    expect(diff.left[1].changed).toBe(false);
  });

  it("片側だけ伸びたときは追加ぶんだけが変更になる", () => {
    const diff = wordDiff("abcdefgh", "abcdefghij");
    expect(diff.left).toEqual([{ text: "abcdefgh", changed: false }]);
    expect(diff.right).toEqual([
      { text: "abcdefgh", changed: false },
      { text: "ij", changed: true },
    ]);
  });

  it("共通部分が短すぎるときは行全体を変更として扱う", () => {
    const diff = wordDiff("まったく違う行です", "何もかも別の内容");
    expect(diff.left).toEqual([{ text: "まったく違う行です", changed: true }]);
    expect(diff.right).toEqual([{ text: "何もかも別の内容", changed: true }]);
  });

  it("日本語でも境界が壊れない", () => {
    const diff = wordDiff("これは日本語の行です", "これは日本語の文です");
    expect(diff.left).toEqual([
      { text: "これは日本語の", changed: false },
      { text: "行", changed: true },
      { text: "です", changed: false },
    ]);
  });

  it("片側が空でも落ちない", () => {
    const diff = wordDiff("", "追加された行");
    expect(diff.left).toEqual([]);
    expect(diff.right).toEqual([{ text: "追加された行", changed: true }]);
  });

  it("同じ行なら変更部分が無い", () => {
    const diff = wordDiff("same", "same");
    expect(diff.left).toEqual([{ text: "same", changed: false }]);
  });
});

describe("wordSegments", () => {
  it("対応する行だけに区切りが付く", () => {
    const removed = line("removed", "value = 1;", 1, null);
    const added = line("added", "value = 2;", null, 1);
    const orphan = line("added", "value = 3;", null, 2);
    const context = line("context", "x", 2, 3);

    const segments = wordSegments(hunkOf([removed, added, orphan, context]));

    expect(segments.get(removed)?.some((segment) => segment.changed)).toBe(true);
    expect(segments.get(added)?.some((segment) => segment.changed)).toBe(true);
    // 相手のいない行とコンテキスト行は入らない。
    expect(segments.has(orphan)).toBe(false);
    expect(segments.has(context)).toBe(false);
  });

  it("同じ本文の行が複数あっても取り違えない", () => {
    const first = line("removed", "dup", 1, null);
    const second = line("removed", "dup", 2, null);
    const added = line("added", "dup!", null, 1);

    const segments = wordSegments(hunkOf([first, second, added]));

    expect(segments.has(first)).toBe(true);
    expect(segments.has(second)).toBe(false);
  });
});
