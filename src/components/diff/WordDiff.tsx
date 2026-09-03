/**
 * 差分 1 行の本文（docs/DESIGN.md §7.2, §9.2）。
 *
 * 行内のどこが変わったかは `diffView.wordSegments` が決める（純関数）。ここは描くだけ。
 * 改行コードの可視化記号もここで足す — **記号は本文ではない**ので、
 * コピーしたときに紛れ込まないよう別の要素にしておく。
 */
import { ja } from "../../i18n/ja";
import type { Segment } from "../../lib/diffView";
import type { DiffLine } from "../../lib/ipc";

export function WordDiff({
  line,
  segments,
  showLineEndings,
}: {
  line: DiffLine;
  /** 対応する行が無ければ `undefined`。そのときは本文をそのまま出す。 */
  segments: Segment[] | undefined;
  showLineEndings: boolean;
}) {
  return (
    <span className="dline__text">
      {segments === undefined
        ? line.text
        : segments.map((segment, index) =>
            segment.changed ? (
              <mark key={index} className="dline__word">
                {segment.text}
              </mark>
            ) : (
              <span key={index}>{segment.text}</span>
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
