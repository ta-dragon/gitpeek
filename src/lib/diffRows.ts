/**
 * 差分を仮想スクロールに載せる形へ均す（純関数。docs/DESIGN.md §7.2, §14.4）。
 *
 * **hunk の見出しも同じ行リストに入れる。** 見出しだけ外に描くと仮想化の対象から
 * 外れてしまい、hunk が数千ある差分で結局全部が DOM に載る。
 */
import { pairHunk, wordSegments, type Segment } from "./diffView";
import type { DiffLine, Hunk, UiSettings } from "./ipc";

/** 画面に出す 1 行。左右に並べるかどうかで中身が変わる。 */
export type DiffRow =
  | { kind: "hunk"; hunk: Hunk }
  /** side-by-side の 1 行。**空欄は行が無いこと**を示す（行番号も持たない）。 */
  | { kind: "pair"; left: DiffLine | null; right: DiffLine | null }
  /** unified の 1 行。 */
  | { kind: "single"; line: DiffLine };

export type DiffLayout = UiSettings["diffLayout"];

/** hunk の並びを 1 本の行リストにする。 */
export function buildRows(hunks: Hunk[], layout: DiffLayout): DiffRow[] {
  const rows: DiffRow[] = [];

  for (const hunk of hunks) {
    rows.push({ kind: "hunk", hunk });
    if (layout === "unified") {
      for (const line of hunk.lines) rows.push({ kind: "single", line });
    } else {
      for (const { left, right } of pairHunk(hunk)) rows.push({ kind: "pair", left, right });
    }
  }

  return rows;
}

/**
 * 変更後の行番号 `line` を出している行の索引。無ければ `null`。
 *
 * **AI レビューの指摘から差分の行へ飛ぶために使う**（利用者の要望。2026-09-06）。
 * 仮想スクロールなので、飛ぶ先は「行」ではなく**行リストの索引**でなければならない
 * （DOM に無い行は掴めない）。
 *
 * **指摘は変更後の行番号で指す**という約束なので、削除された行しか無い場所へは
 * 飛べない（`null` が返る）。**当たらなかったことは呼び出し側が画面に出す** —
 * 黙って先頭に留まると、押しても何も起きないように見える。
 */
export function rowIndexForLine(rows: DiffRow[], line: number): number | null {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind === "single" && row.line.newLine === line) return index;
    // side-by-side では変更後の行は右側にある。**左側の行番号で引かない。**
    if (row.kind === "pair" && row.right !== null && row.right.newLine === line) return index;
  }
  return null;
}

/**
 * 行内差分を差分ぜんぶに対して 1 度だけ求める。
 *
 * `wordSegments` は hunk 単位なので、行リストを作るときに 1 つに畳んでおく。
 * **行を描くたびに呼ばないこと。**
 */
export function allWordSegments(hunks: Hunk[]): Map<DiffLine, Segment[]> {
  const all = new Map<DiffLine, Segment[]>();
  for (const hunk of hunks) {
    for (const [line, segments] of wordSegments(hunk)) all.set(line, segments);
  }
  return all;
}

/** 差分の大きさ。折りたたむかどうかの判断に使う。 */
export type DiffSize = { lines: number; bytes: number };

/**
 * 差分の規模を測る。
 *
 * バイト数は**本文を UTF-8 として数えた長さ**。`length`（UTF-16 の符号単位）で
 * 代用すると、日本語のファイルが実際の 3 分の 1 の大きさに見えてしまう。
 */
export function measureDiff(hunks: Hunk[]): DiffSize {
  let lines = 0;
  let bytes = 0;

  for (const hunk of hunks) {
    lines += hunk.lines.length;
    for (const line of hunk.lines) bytes += utf8Length(line.text);
  }

  return { lines, bytes };
}

/** 文字列を UTF-8 にしたときのバイト数。`TextEncoder` と違って中間の配列を作らない。 */
export function utf8Length(text: string): number {
  let bytes = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // サロゲートペア。2 つで 4 バイトなので、後続を読み飛ばす。
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }

  return bytes;
}

/**
 * 大きすぎて既定では開かないか。
 *
 * **どちらか一方でも超えたら折りたたむ。** 行数だけ見ていると、1 行が極端に長い
 * ファイル（minify 済みなど）を素通しさせてしまう。
 */
export function shouldCollapse(size: DiffSize, ui: UiSettings): boolean {
  return size.lines > ui.collapseLines || size.bytes > ui.collapseBytes;
}

/**
 * バイト数を読める形にする。**1024 区切り**（ファイルサイズなので）。
 *
 * 1KB 未満はそのまま出す。小さいバイナリの差分では「6 B → 8 B」のように
 * 実数が見えたほうが早い。
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // 10 以上は小数を出さない（桁が増えるほど 0.1 の意味が薄れる）。
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}
