/**
 * side-by-side 表示（docs/DESIGN.md §7.2）。既定はこちら。
 *
 * **1 行を 1 つの grid にする。** 行ごとに 4 列（旧行番号 / 旧本文 / 新行番号 / 新本文）を
 * 並べるので、本文が折り返しても左右が同じ行に留まる。列を縦に 4 本並べる作りだと、
 * 片側だけ折り返した瞬間に以降の行が全部ずれる。
 */
import { Fragment, useMemo } from "react";

import { ja } from "../../i18n/ja";
import { pairHunk, wordSegments, type Segment } from "../../lib/diffView";
import type { DiffLine, Hunk } from "../../lib/ipc";
import { WordDiff } from "./WordDiff";

export function SideBySide({
  hunks,
  showLineEndings,
}: {
  hunks: Hunk[];
  showLineEndings: boolean;
}) {
  return (
    <div className="dtable">
      {hunks.map((hunk, index) => (
        <HunkRows key={index} hunk={hunk} showLineEndings={showLineEndings} />
      ))}
    </div>
  );
}

function HunkRows({ hunk, showLineEndings }: { hunk: Hunk; showLineEndings: boolean }) {
  // 行の対応付けと行内差分は hunk ごとに 1 度だけ。行の描画のたびに回さない。
  const rows = useMemo(() => pairHunk(hunk), [hunk]);
  const segments = useMemo(() => wordSegments(hunk), [hunk]);

  return (
    <Fragment>
      <HunkHeading hunk={hunk} />
      {rows.map((row, index) => (
        <div className="drow drow--split" key={index}>
          <Side
            line={row.left}
            number={row.left?.oldLine ?? null}
            segments={row.left === null ? undefined : segments.get(row.left)}
            showLineEndings={showLineEndings}
          />
          <Side
            line={row.right}
            number={row.right?.newLine ?? null}
            segments={row.right === null ? undefined : segments.get(row.right)}
            showLineEndings={showLineEndings}
          />
        </div>
      ))}
    </Fragment>
  );
}

function Side({
  line,
  number,
  segments,
  showLineEndings,
}: {
  line: DiffLine | null;
  number: number | null;
  segments: Segment[] | undefined;
  showLineEndings: boolean;
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
        <WordDiff line={line} segments={segments} showLineEndings={showLineEndings} />
      </span>
    </>
  );
}

/** hunk の切れ目。間に飛ばした行があることを示す。 */
export function HunkHeading({ hunk }: { hunk: Hunk }) {
  return (
    <div className="dhunk">
      <span className="dhunk__range">
        {ja.diff.hunkRange(hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines)}
      </span>
      {hunk.heading !== "" && <span className="dhunk__heading">{hunk.heading}</span>}
    </div>
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
