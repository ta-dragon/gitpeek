/**
 * unified 表示（docs/DESIGN.md §7.2）。
 *
 * 行内のハイライトは side-by-side と**同じ対応付け**を使う。左右に並べないだけで、
 * 「どの削除行がどの追加行になったか」の解釈まで変える理由はない。
 */
import { Fragment, useMemo } from "react";

import { wordSegments } from "../../lib/diffView";
import type { Hunk } from "../../lib/ipc";
import { HunkHeading, markOf } from "./SideBySide";
import { WordDiff } from "./WordDiff";

export function Unified({
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
  const segments = useMemo(() => wordSegments(hunk), [hunk]);

  return (
    <Fragment>
      <HunkHeading hunk={hunk} />
      {hunk.lines.map((line, index) => (
        <div className="drow drow--unified" key={index}>
          <span className="dline__no">{line.oldLine ?? ""}</span>
          <span className="dline__no">{line.newLine ?? ""}</span>
          <span className={`dline dline--${line.kind}`}>
            <span className="dline__mark">{markOf(line.kind)}</span>
            <WordDiff
              line={line}
              segments={segments.get(line)}
              showLineEndings={showLineEndings}
            />
          </span>
        </div>
      ))}
    </Fragment>
  );
}
