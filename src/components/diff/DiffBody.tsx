/**
 * 差分本体の行を並べる（docs/DESIGN.md §7.2）。
 *
 * **仮想スクロール。** hunk の行を全部 DOM にすると、数千行の差分でスクロールが
 * 止まる。**hunk の見出しも同じ行リストに入れてある** — 別に描くと見出しだけが
 * 仮想化から漏れる。
 *
 * **行の高さは実測する。** 本文を折り返す（横スクロールにしない）ので高さが一定でない。
 * 推定値は 1 行ぶんでよく、折り返した行だけ測り直しが効く。
 *
 * シンタックスハイライトは**非同期**。先に素の本文を出し、トークンが揃ったら
 * 色だけ足す。読み込み中に何も出さないと、ファイルを移るたびに画面が白く飛ぶ。
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { useResolvedTheme } from "../../hooks/useTheme";
import { allWordSegments, buildRows, type DiffLayout, type DiffRow } from "../../lib/diffRows";
import { highlightDiff, languageOf, type Chunk } from "../../lib/highlight";
import type { DiffLine, Finding, Hunk } from "../../lib/ipc";
import { bySeverity, placeFindings } from "../../lib/reviewFindings";
import { HunkHeading, SplitRow, type RowContext } from "./SideBySide";
import { UnifiedRow } from "./Unified";

/** 折り返していない行と hunk 見出しのおよその高さ。実測が入るまでの当て。 */
const LINE_HEIGHT = 19;
const HUNK_HEIGHT = 22;

const NO_COLORS = new Map<DiffLine, Chunk[]>();

export function DiffBody({
  path,
  hunks,
  layout,
  showLineEndings,
  findings,
  scrollRef,
}: {
  /** ハイライトの言語を決めるのに使う。 */
  path: string;
  hunks: Hunk[];
  layout: DiffLayout;
  showLineEndings: boolean;
  /**
   * このファイルに付いた AI レビューの指摘（T-23）。
   *
   * **差分に無い行を指したものはここでは出さない。** 振り分けは
   * `lib/reviewFindings.ts` の純関数が決める（無い行に出すと別の行の指摘に見える）。
   */
  findings: Finding[];
  /** スクロールしているのは `.dpane__body`。仮想化はその上で行う。 */
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const rows = useMemo(() => buildRows(hunks, layout), [hunks, layout]);
  const placed = useMemo(() => placeFindings(findings, hunks).byLine, [findings, hunks]);
  const segments = useMemo(() => allWordSegments(hunks), [hunks]);
  const colors = useHighlight(path, hunks);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index].kind === "hunk" ? HUNK_HEIGHT : LINE_HEIGHT),
    overscan: 12,
  });

  // 別のファイルへ移ったら先頭から見せる。**実測値も捨てる** —
  // 索引ごとに覚えているので、中身が入れ替わると前のファイルの高さが残る。
  const measured = useRef(rows);
  useEffect(() => {
    if (measured.current === rows) return;
    measured.current = rows;
    virtualizer.scrollToOffset(0);
    virtualizer.measure();
  }, [rows, virtualizer]);

  const context: RowContext = { segments, colors, showLineEndings };

  return (
    <div className="dtable" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        return (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className={classOf(row.kind, layout)}
            style={{ transform: `translateY(${item.start}px)` }}
          >
            {row.kind === "hunk" ? (
              <HunkHeading hunk={row.hunk} />
            ) : row.kind === "single" ? (
              <UnifiedRow line={row.line} context={context} />
            ) : (
              <SplitRow left={row.left} right={row.right} context={context} />
            )}
            <FindingBadge findings={placed.get(newLineOf(row) ?? -1)} />
          </div>
        );
      })}
    </div>
  );
}

/** その行の変更後の行番号。**指摘は変更後の行で指す**（system プロンプトの約束）。 */
function newLineOf(row: DiffRow): number | null {
  if (row.kind === "single") return row.line.newLine;
  if (row.kind === "pair") return row.right?.newLine ?? null;
  return null;
}

/**
 * 指摘が付いた行の印（T-23）。
 *
 * **一番重いものの色で 1 つだけ出す。** 同じ行に何件あっても行が伸びない。
 * 中身はドロワー側で読む（ここは「ここに指摘がある」を示すだけ）。
 */
function FindingBadge({ findings }: { findings: Finding[] | undefined }) {
  if (findings === undefined || findings.length === 0) return null;
  const worst = bySeverity(findings)[0];
  return (
    <span
      className={`drow__badge drow__badge--${worst.severity}`}
      title={findings.map((finding) => finding.title).join(" / ")}
    >
      {findings.length === 1 ? "!" : findings.length}
    </span>
  );
}

function classOf(kind: "hunk" | "pair" | "single", layout: DiffLayout): string {
  if (kind === "hunk") return "drow drow--hunk dhunk";
  return `drow drow--${layout === "unified" ? "unified" : "split"}`;
}

/**
 * ハイライトのトークンを非同期に用意する。
 *
 * 言語が分からないファイルと、大きすぎる差分では空のまま返る（`highlightDiff` が
 * 決める）。**取り違えを防ぐため、遅れて届いた結果は捨てる。**
 */
function useHighlight(path: string, hunks: Hunk[]): Map<DiffLine, Chunk[]> {
  const [colors, setColors] = useState(NO_COLORS);
  const theme = useResolvedTheme();

  useEffect(() => {
    const language = languageOf(path);
    setColors(NO_COLORS);
    if (language === null || hunks.length === 0) return;

    let current = true;
    void highlightDiff(hunks, language, theme)
      .then((result) => {
        if (current) setColors(result);
      })
      .catch(() => {
        // 文法が読めなくても差分は読める。素の本文のままにする。
      });

    return () => {
      current = false;
    };
  }, [path, hunks, theme]);

  return colors;
}
