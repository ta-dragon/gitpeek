/**
 * 差分の表示用の組み立て（純関数。docs/DESIGN.md §7.2, §14.4）。
 *
 * **パース済みの hunk を受け取る**（パースは Rust 側 — `git/diff.rs`）。ここでやるのは
 * 「2 列に並べるための行の対応付け」と「行内のどこが変わったか」の 2 つだけで、
 * どちらも入出力が閉じた純関数なのでテストできる。
 */
import type { DiffLine, Hunk } from "./ipc";

/** side-by-side の 1 行。**空欄は行が無いことを示す**（行番号も持たない）。 */
export type SideBySideRow = {
  left: DiffLine | null;
  right: DiffLine | null;
};

/**
 * hunk を 2 列に並べる。
 *
 * 変わっていない行は左右に同じ行を置く。連続する削除の並びと追加の並びは
 * **索引で突き合わせ**、数が違えば余りを空欄にする。
 */
export function pairHunk(hunk: Hunk): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];

  const flush = (): void => {
    const count = Math.max(removed.length, added.length);
    for (let index = 0; index < count; index += 1) {
      rows.push({ left: removed[index] ?? null, right: added[index] ?? null });
    }
    removed = [];
    added = [];
  };

  for (const line of hunk.lines) {
    if (line.kind === "context") {
      flush();
      rows.push({ left: line, right: line });
      continue;
    }
    if (line.kind === "removed") removed.push(line);
    else added.push(line);
  }
  flush();

  return rows;
}

/** 行内の一区切り。`changed` の部分だけ色を付ける。 */
export type Segment = { text: string; changed: boolean };

/**
 * 共通部分がこれだけ短ければ、行内の対応付けを諦めて全体を変更として扱う。
 *
 * まるごと書き換えた行に細かいハイライトを出すと、共通の記号（括弧やカンマ）が
 * 飛び飛びに残って**かえって読めない**。
 */
const MIN_COMMON_RATIO = 0.3;

/**
 * 行内の差分を出す。**共通の先頭と末尾を削るだけ**にしてある。
 *
 * LCS を回さないのは、日本語では語境界が取れないうえ、実際の差分は
 * 「行内の 1 箇所を直した」が大半を占めるため。真ん中に共通部分が残る場合は
 * 取りこぼすが、その行は元々まるごと読み直すことになる。
 *
 * 比較は**コードポイント単位**（`Array.from`）。UTF-16 の符号単位で切ると
 * 絵文字や一部の漢字が壊れる。
 */
export function wordDiff(left: string, right: string): { left: Segment[]; right: Segment[] } {
  const a = Array.from(left);
  const b = Array.from(right);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const longest = Math.max(a.length, b.length);
  if (longest > 0 && prefix + suffix < longest * MIN_COMMON_RATIO) {
    return {
      left: left === "" ? [] : [{ text: left, changed: true }],
      right: right === "" ? [] : [{ text: right, changed: true }],
    };
  }

  return {
    left: split(a, prefix, suffix),
    right: split(b, prefix, suffix),
  };
}

function split(chars: string[], prefix: number, suffix: number): Segment[] {
  const head = chars.slice(0, prefix).join("");
  const middle = chars.slice(prefix, chars.length - suffix).join("");
  const tail = chars.slice(chars.length - suffix).join("");

  const segments: Segment[] = [];
  if (head !== "") segments.push({ text: head, changed: false });
  if (middle !== "") segments.push({ text: middle, changed: true });
  if (tail !== "") segments.push({ text: tail, changed: false });
  return segments;
}

/**
 * hunk 内の行に対する行内差分の一覧。
 *
 * **行そのものを鍵にする**（同じ本文の行が複数あっても取り違えない）。
 * 対応する相手がいない行は入らないので、その行は全体を変更として描く。
 *
 * unified 表示でも同じ対応付けを使う。左右に並べないだけで、
 * 「どの削除行がどの追加行になったか」の解釈は変えないため。
 */
export function wordSegments(hunk: Hunk): Map<DiffLine, Segment[]> {
  const segments = new Map<DiffLine, Segment[]>();

  for (const row of pairHunk(hunk)) {
    const { left, right } = row;
    if (left === null || right === null) continue;
    if (left.kind === "context") continue;

    const diff = wordDiff(left.text, right.text);
    segments.set(left, diff.left);
    segments.set(right, diff.right);
  }

  return segments;
}
