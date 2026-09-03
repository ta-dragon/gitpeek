/**
 * side-by-side の 1 行（docs/DESIGN.md §7.2）。既定はこちら。
 *
 * **1 行が 1 つの grid になっている。** 4 列（旧行番号 / 旧本文 / 新行番号 / 新本文）を
 * 行の中に並べるので、本文が折り返しても左右が同じ行に留まる。列を縦に 4 本並べる
 * 作りだと、片側だけ折り返した瞬間に以降の行が全部ずれる。
 *
 * 行を並べるのは `DiffBody`（仮想スクロール）。ここは 1 行を描くだけ。
 */
import { ja } from "../../i18n/ja";
import type { Segment } from "../../lib/diffView";
import type { Chunk } from "../../lib/highlight";
import type { DiffLine, Hunk } from "../../lib/ipc";
import { WordDiff } from "./WordDiff";

/** 行を描くのに要るもの一式。行の種類が違っても中身は同じなのでまとめて渡す。 */
export type RowContext = {
  segments: Map<DiffLine, Segment[]>;
  colors: Map<DiffLine, Chunk[]>;
  showLineEndings: boolean;
};

export function SplitRow({
  left,
  right,
  context,
}: {
  left: DiffLine | null;
  right: DiffLine | null;
  context: RowContext;
}) {
  return (
    <>
      <Side line={left} number={left?.oldLine ?? null} context={context} />
      <Side line={right} number={right?.newLine ?? null} context={context} />
    </>
  );
}

function Side({
  line,
  number,
  context,
}: {
  line: DiffLine | null;
  number: number | null;
  context: RowContext;
}) {
  // 空欄は「行が無い」ことを示すだけ。行番号も持たない（docs/DESIGN.md §7.2）。
  if (line === null) {
    return (
      <>
        <span className="dline__no" />
        <span className="dline dline--empty" />
      </>
    );
  }

  return (
    <>
      <span className="dline__no">{number ?? ""}</span>
      <span className={`dline dline--${line.kind}`}>
        <span className="dline__mark">{markOf(line.kind)}</span>
        <WordDiff
          line={line}
          segments={context.segments.get(line)}
          colors={context.colors.get(line)}
          showLineEndings={context.showLineEndings}
        />
      </span>
    </>
  );
}

/** hunk の切れ目。間に飛ばした行があることを示す。 */
export function HunkHeading({ hunk }: { hunk: Hunk }) {
  return (
    <>
      <span className="dhunk__range">
        {ja.diff.hunkRange(hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines)}
      </span>
      {hunk.heading !== "" && <span className="dhunk__heading">{hunk.heading}</span>}
    </>
  );
}

export function markOf(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "added":
      return "+";
    case "removed":
      return "-";
    case "context":
      return " ";
  }
}
