/**
 * 差分 1 行の本文（docs/DESIGN.md §7.2, §9.2）。
 *
 * 行内のどこが変わったかは `diffView.wordSegments` が、色は `highlight` が決める
 * （どちらも純関数）。ここは重ねて描くだけ。
 * 改行コードの可視化記号もここで足す — **記号は本文ではない**ので、
 * コピーしたときに紛れ込まないよう別の要素にしておく。
 */
import { ja } from "../../i18n/ja";
import type { Segment } from "../../lib/diffView";
import { mergeHighlight, plainChanged, type Chunk } from "../../lib/highlight";
import type { DiffLine } from "../../lib/ipc";

export function WordDiff({
  line,
  segments,
  colors,
  showLineEndings,
}: {
  line: DiffLine;
  /** 対応する行が無ければ `undefined`。そのときは行全体を 1 区切りとして扱う。 */
  segments: Segment[] | undefined;
  /** ハイライトのトークン。読み込みが済むまでは `undefined`。 */
  colors: Chunk[] | undefined;
  showLineEndings: boolean;
}) {
  const base: Segment[] =
    segments ?? (line.text === "" ? [] : [{ text: line.text, changed: false }]);

  return (
    <span className="dline__text">
      {plainChanged(mergeHighlight(base, colors)).map((segment, index) =>
        segment.changed ? (
          // 強調の中は 1 色（色は CSS の `.dline__word` が決める）。
          <mark key={index} className="dline__word">
            {segment.text}
          </mark>
        ) : (
          <span key={index} style={colorOf(segment.color)}>
            {segment.text}
          </span>
        ),
      )}
      {showLineEndings && line.ending !== null && (
        <span className="dline__eol" aria-hidden="true">
          {ja.diff.eolMarks[line.ending]}
        </span>
      )}
      {/*
       * 末尾に改行が無いことは**可視化トグルに関わらず**知らせる（差分の意味が変わる）。
       * 記号ではなく言葉にしてある — 「無い」ことを表す記号は伝わらない。
       */}
      {line.ending === null && (
        <span className="dline__note" title={ja.diff.noNewline}>
          {ja.diff.noNewlineMark}
        </span>
      )}
    </span>
  );
}

/** 色が決まっていない部分は本文の色に任せる（テーマトークンと食い違わせない）。 */
function colorOf(color: string | null): { color: string } | undefined {
  return color === null ? undefined : { color };
}
