/**
 * 指摘を差分の行へ対応させる（T-23。純関数）。
 *
 * **差分に無い行にはバッジを出さない。** モデルは差分に現れない行番号をよく書く。
 * 無い行に出すと**別の行の指摘に見える**ので、当たらなかったものは
 * ドロワー側に残し、当たらなかったと明記する（**消さない**。CLAUDE.md §6）。
 */
import type { Finding, Hunk, ReviewFileResult, ReviewRun, Severity } from "./ipc";

/** 重さの並び順。**重いものを先に出す。** */
const ORDER: Record<Severity, number> = { critical: 0, major: 1, minor: 2, info: 3 };

/** 重さで並べ替える（同じ重さなら元の順を保つ）。 */
export function bySeverity(findings: Finding[]): Finding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => ORDER[a.finding.severity] - ORDER[b.finding.severity] || a.index - b.index)
    .map((it) => it.finding);
}

/** 差分の行へ結び付けた結果。 */
export type FindingPlacement = {
  /** 変更後の行番号ごとの指摘。**その行が差分にあるものだけ。** */
  byLine: Map<number, Finding[]>;
  /** ファイル全体への指摘（`line` が `null`）。 */
  whole: Finding[];
  /** **差分に無い行を指していたもの。** ドロワーに残して理由を出す。 */
  offDiff: Finding[];
};

/**
 * 差分に出ている変更後の行番号。
 *
 * **開いている差分のぶんは画面の外へも渡す** — ドロワー側で「当たらなかった指摘」を
 * 明記するのに要る（CLAUDE.md §6）。
 */
export function newLines(hunks: Hunk[]): Set<number> {
  const lines = new Set<number>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== null) lines.add(line.newLine);
    }
  }
  return lines;
}

/**
 * 指摘を差分の行へ振り分ける。
 *
 * `line` は**変更後の行番号**として扱う（system プロンプトでそう要求している）。
 * 削除された行だけを指した指摘は変更後の行番号を持てないので、
 * **`offDiff` へ落ちる**（行に付けようが無い）。
 */
export function placeFindings(findings: Finding[], hunks: Hunk[]): FindingPlacement {
  const available = newLines(hunks);
  const byLine = new Map<number, Finding[]>();
  const whole: Finding[] = [];
  const offDiff: Finding[] = [];

  for (const finding of findings) {
    if (finding.line === null) {
      whole.push(finding);
      continue;
    }
    if (!available.has(finding.line)) {
      offDiff.push(finding);
      continue;
    }
    const already = byLine.get(finding.line);
    // **同じ行に 2 件以上あっても落とさない。**
    if (already === undefined) byLine.set(finding.line, [finding]);
    else already.push(finding);
  }

  return { byLine, whole, offDiff };
}

/**
 * この走りのうち、あるファイルに付いた指摘。
 *
 * **`finding.file` ではなく、結果の入れ物のパスで引く。** モデルが書いた
 * `file` は当てにならない（空だったり別のパスだったりする）。Rust 側が
 * 空欄をいま見ているファイル名で埋めているが、**入れ物のほうが確か**。
 */
export function findingsFor(run: ReviewRun, path: string): Finding[] {
  const file = run.files.find((it) => it.path === path);
  if (file === undefined || file.text === null) return [];
  return bySeverity(file.text.findings);
}

/** 走り全体の指摘数。**サマリのぶんは数えない**（重複するため）。 */
export function countFindings(run: ReviewRun): number {
  return run.files.reduce((total, file) => total + (file.text?.findings.length ?? 0), 0);
}

/** ファイル 1 件の状態。**失敗と「構造化に失敗」を混ぜない。** */
export type FileOutcome = "ok" | "fallback" | "failed" | "empty";

export function outcomeOf(file: ReviewFileResult): FileOutcome {
  if (file.error !== null) return "failed";
  if (file.text === null) return "empty";
  if (file.text.markdown !== null) return "fallback";
  return "ok";
}

/**
 * いま差分ペインに出ているファイルの行（T-23 の追補）。
 *
 * **開いていないファイルのことは分からない。** 分からないものを「当たらなかった」と
 * 書くと嘘になるので、`null` を返して何も書かない。
 */
export type LineLookup = { path: string; lines: Set<number> } | null;

/**
 * その指摘が差分の行に当たるか。**分からなければ `null`。**
 *
 * - `line` が `null`（ファイル全体への指摘）→ 行には当たらないが「外した」わけでもない
 * - 開いているファイルと違う → 分からない（`null`）
 */
export function landsOn(lookup: LineLookup, path: string, line: number | null): boolean | null {
  if (line === null) return null;
  if (lookup === null || lookup.path !== path) return null;
  return lookup.lines.has(line);
}
