/**
 * unified の 1 行（docs/DESIGN.md §7.2）。
 *
 * 行内のハイライトは side-by-side と**同じ対応付け**を使う。左右に並べないだけで、
 * 「どの削除行がどの追加行になったか」の解釈まで変える理由はない。
 */
import type { DiffLine } from "../../lib/ipc";
import { markOf, type RowContext } from "./SideBySide";
import { WordDiff } from "./WordDiff";

export function UnifiedRow({ line, context }: { line: DiffLine; context: RowContext }) {
  return (
    <>
      <span className="dline__no">{line.oldLine ?? ""}</span>
      <span className="dline__no">{line.newLine ?? ""}</span>
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
