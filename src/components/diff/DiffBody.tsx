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
import {
  allWordSegments,
  rowIndexForLine,
  type DiffLayout,
  type DiffRow,
} from "../../lib/diffRows";
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
  rows,
  layout,
  showLineEndings,
  findings,
  jumpTo,
  hits,
  scrollTo,
  scrollRef,
}: {
  /** ハイライトの言語を決めるのに使う。 */
  path: string;
  hunks: Hunk[];
  /**
   * 並べる行。**`DiffPane` が組み立てて渡す**（検索も同じ行番号で数えるので、
   * 2 か所で組み立てるとずれる）。
   */
  rows: DiffRow[];
  layout: DiffLayout;
  showLineEndings: boolean;
  /**
   * このファイルに付いた AI レビューの指摘（T-23）。
   *
   * **差分に無い行を指したものはここでは出さない。** 振り分けは
   * `lib/reviewFindings.ts` の純関数が決める（無い行に出すと別の行の指摘に見える）。
   */
  findings: Finding[];
  /**
   * 指摘から飛んできた行（利用者の要望。2026-09-06）。
   *
   * **`nonce` は「押した回数」。** 同じ行をもう一度押しても飛べるように、
   * 行番号だけでなくこれで見分ける。**この差分に無い行なら何もしない**
   * （当たらなかったことはドロワー側が文言で出す）。
   */
  jumpTo: { line: number; nonce: number } | null;
  /** 検索で当たった行（T-25）。**印を付けるだけ**で、文字は塗らない。 */
  hits: Set<number>;
  /** 検索で動かす先の行。**`nonce` は押した回数**（同じ当たりへもう一度飛べる）。 */
  scrollTo: { row: number; nonce: number } | null;
  /**
   * スクロールしているのは `.dpane__body`。仮想化はその上で行う。
   *
   * **フォーカス用の ref（外枠の `.dpane`）を渡さない。** 渡すと、スクロールしない要素を
   * 見張ることになり、描く行が先頭で固まる（docs/DESIGN.md §17.1）。
   */
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  /** 飛んできた先の行。**印を残す** — 動いただけだとどれが目的の行か分からない。 */
  const [target, setTarget] = useState<number | null>(null);
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
    setTarget(null);
    virtualizer.scrollToOffset(0);
    virtualizer.measure();
  }, [rows, virtualizer]);

  /**
   * 指摘から飛んできた行まで動かす。
   *
   * **一度処理した押下は覚えておく** — 表示の設定を変えて行リストが作り直されるたびに
   * 飛び直すと、読んでいる場所を勝手に奪う。逆に**別のファイルを開いた直後は
   * 行リストが後から届く**ので、行リストが変わったときにも試し直す必要がある。
   */
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (jumpTo === null) {
      handled.current = null;
      return;
    }
    if (handled.current === jumpTo.nonce) return;

    const index = rowIndexForLine(rows, jumpTo.line);
    // **この差分に無い行なら動かさない。** 近くの行へ寄せると別の行の指摘に見える。
    if (index === null) {
      handled.current = jumpTo.nonce;
      setTarget(null);
      return;
    }

    handled.current = jumpTo.nonce;
    setTarget(jumpTo.line);
    // **行の高さは実測**なので 1 度目は当て推量の位置に着くが、`scrollToIndex` は
    // 測り終わるまで寄せ直す（`virtual-core` の scroll reconcile）。自分で
    // 追いかけない — 同じ目標へ二重に指示することになる。
    virtualizer.scrollToIndex(index, { align: "center" });
  }, [jumpTo, rows, virtualizer]);

  /**
   * 検索で当たった行まで動かす（T-25）。
   *
   * **指摘から飛ぶのとは別に持つ。** あちらは行番号（差分の中の行）で、
   * こちらは行リストの添字（当たりの順番）なので、同じ入口にできない。
   */
  const handledSearch = useRef<number | null>(null);
  useEffect(() => {
    if (scrollTo === null) {
      handledSearch.current = null;
      return;
    }
    if (handledSearch.current === scrollTo.nonce) return;
    if (scrollTo.row < 0 || scrollTo.row >= rows.length) return;

    handledSearch.current = scrollTo.nonce;
    virtualizer.scrollToIndex(scrollTo.row, { align: "center" });
  }, [scrollTo, rows.length, virtualizer]);

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
            className={classOf(row.kind, layout, newLineOf(row) === target, hits.has(item.index))}
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

function classOf(
  kind: "hunk" | "pair" | "single",
  layout: DiffLayout,
  target: boolean,
  hit: boolean,
): string {
  const mark = `${target ? " drow--target" : ""}${hit ? " drow--hit" : ""}`;
  if (kind === "hunk") return `drow drow--hunk dhunk${mark}`;
  return `drow drow--${layout === "unified" ? "unified" : "split"}${mark}`;
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
