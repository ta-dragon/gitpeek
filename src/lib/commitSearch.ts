/**
 * 探した結果を行に落とす（T-35。純関数。docs/DESIGN.md §6.6）。
 *
 * **グラフと行は変えない。** 当たった行に印を付け、件数と前後移動で辿る
 * （差分内検索と同じ見せ方）。行を絞らないのは、レーンが**可視 ref の到達可能集合**
 * から計算されているためで、任意の部分集合に絞ると線が意味を失う（CLAUDE.md §3）。
 *
 * **表示していない ref の側に当たったぶんは、件数として残す。** 黙って落とすと、
 * 「探したのに出ない」のか「そもそも当たっていない」のか読めなくなる。
 */
import { wantsCode, type CommitQuery, type QueryNotice } from "./commitQuery";
import { stepHit } from "./diffSearch";

/** 端で折り返す前後移動。**差分内検索と同じ決まりを 2 つ持たない**ので再利用する。 */
export { stepHit };

export type SearchHits = {
  /** 当たった行の番号（表示している並びでの昇順）。 */
  rows: number[];
  /** 当たったが、いま表示していない件数（可視 ref の絞り込みで行が無いもの）。 */
  hidden: number;
};

/** 1 件も当たっていない状態。 */
export const NO_HITS: SearchHits = { rows: [], hidden: 0 };

/**
 * 当たった SHA を行番号に直す。
 *
 * `shown` は**表示している並びそのもの**（`LaneLayout.rows` から作ったもの）を渡すこと。
 * 読み込んだ全コミットを渡すと、絞り込みや date 表示で**印が 1 行ずつずれる**。
 */
export function hitsIn(shown: readonly string[], shas: readonly string[]): SearchHits {
  const wanted = new Set(shas);
  const rows: number[] = [];
  for (let row = 0; row < shown.length; row += 1) {
    if (wanted.has(shown[row])) rows.push(row);
  }
  return { rows, hidden: Math.max(0, wanted.size - rows.length) };
}

/** いま見ている当たりの行。無ければ `null`。 */
export function rowOf(hits: SearchHits, current: number): number | null {
  if (current < 0 || current >= hits.rows.length) return null;
  return hits.rows[current];
}

/**
 * 探した直後にどの当たりへ行くか。**いま選んでいる行から下へ探し、無ければ先頭へ戻る。**
 *
 * いつも先頭へ飛ぶと、下のほうを見ているときに毎回画面が一番上へ戻る。
 * 1 件も当たっていなければ `-1`（＝どこにも行かない）。
 */
export function hitAfter(hits: SearchHits, fromRow: number | null): number {
  if (hits.rows.length === 0) return -1;
  if (fromRow === null) return 0;
  const found = hits.rows.findIndex((row) => row >= fromRow);
  return found < 0 ? 0 : found;
}

/** 当たった行の集合（印を付けるため）。 */
export function hitRows(hits: SearchHits): Set<number> {
  return new Set(hits.rows);
}

/**
 * コード内容の検索の、初回のレート（コミット / 秒。T-36。docs/DESIGN.md §6.6）。
 *
 * onyx の実測（20,285 コミット / 17.1 秒 ≒ 1,190）から**遅い側に寄せた**値。短く言って
 * 長く待たせると「壊れた」に見えるので、外すなら長めに外す。2 回目からはそのリポジトリの
 * 実測（`state.json` の `codeSearchRate`）を使う。
 */
export const DEFAULT_CODE_SEARCH_RATE = 1_200;

/**
 * 覚えてよい実測の最短。これより短い実行は git の起動にかかる時間が大半を占め、
 * レートが実際より大きく出る（次の見積もりが短くなりすぎる）。
 */
const MIN_LEARNING_MS = 1_000;

/** 完了までの目安（秒）。**1 秒未満でも 1 秒と言う**（「0 秒」は壊れて見える）。 */
export function estimateSeconds(commitCount: number, rate: number | null): number {
  const perSecond = rate !== null && rate > 0 ? rate : DEFAULT_CODE_SEARCH_RATE;
  return Math.max(1, Math.ceil(commitCount / perSecond));
}

/**
 * 今回の実行から覚えるレート。**覚えないときは `null`。**
 *
 * - **`code:` だけの検索しか覚えない。** `message:` と一緒だと git が差分を取るコミットが
 *   減って速く終わる（onyx で 17.1 秒 → 5.9 秒）。それを覚えると、次に `code:` だけで
 *   探したときの目安が 3 分の 1 になり、**短く言って長く待たせる**。逆向き（`code:` だけで
 *   覚えて、絞った検索を長めに見積もる）は外れても害が小さい
 * - 中止した実行は覚えない（最後まで見ていない）
 * - 短すぎる実行は覚えない（`MIN_LEARNING_MS`）
 */
export function learnedRate(
  query: CommitQuery,
  outcome: { elapsedMs: number; cancelled: boolean },
  commitCount: number,
): number | null {
  const codeOnly =
    wantsCode(query) && query.any === null && query.message === null && query.author === null;
  if (!codeOnly || outcome.cancelled) return null;
  if (outcome.elapsedMs < MIN_LEARNING_MS || commitCount <= 0) return null;
  return commitCount / (outcome.elapsedMs / 1_000);
}

/** 走っている間に出すもの。**文言は持たない。** */
export type SearchProgress =
  | { kind: "estimate"; seconds: number; elapsed: number }
  /** 目安を超えた。**残り時間を嘘で出し続けない**ので、経過だけを言う。 */
  | { kind: "overdue"; elapsed: number };

export function searchProgress(estimate: number, elapsedMs: number): SearchProgress {
  const elapsed = Math.floor(elapsedMs / 1_000);
  if (elapsedMs > estimate * 1_000) return { kind: "overdue", elapsed };
  return { kind: "estimate", seconds: estimate, elapsed };
}

/**
 * ツールバーに出す知らせ。**文言は持たない**（`i18n/ja.ts` が種類から引く）。
 *
 * 効かなかった打ち方（`QueryNotice`）もここへ混ぜて、1 列に並べて出す。
 */
export type SearchNote =
  | { kind: "none" }
  | { kind: "hidden"; count: number }
  /** 中止した。**出ている当たりは途中までで、全部ではない。** */
  | { kind: "cancelled" }
  | { kind: "failed"; detail: string }
  | QueryNotice;

/** 画面の出し分けに要る材料。`hooks/useCommitSearch.ts` が持っている値そのもの。 */
export type SearchState = {
  input: string;
  running: boolean;
  searched: boolean;
  hits: SearchHits;
  current: number;
  notices: QueryNotice[];
  /** 直近の検索を中止したか。 */
  cancelled: boolean;
  error: string | null;
  /** コード内容を探している間だけ。目安（秒）と経過（ms）。 */
  timing: { estimateSeconds: number; elapsedMs: number } | null;
};

export type SearchView = {
  /** 「次へ / 前へ」を押せるか。**押せなくても消さない**（CLAUDE.md §6）。 */
  canStep: boolean;
  /** 何件目を見ているか。当たりが無ければ `null`（件数を出さない）。 */
  position: { current: number; total: number } | null;
  /** 「やめる」を出すか。何も打っておらず何も探していなければ出さない。 */
  canClear: boolean;
  /**
   * 中止ボタンを出すか。**コード内容を探している間だけ。** メッセージと作者の検索は
   * 一瞬で終わるので、出すとボタンが一瞬光って消えるだけになる。
   */
  canCancel: boolean;
  progress: SearchProgress | null;
  notes: SearchNote[];
};

/**
 * ツールバーの出し分け。**`.tsx` に判定を書かないために、ここで決める**（CLAUDE.md §8）。
 *
 * - **表示していない側にだけ当たったときは「当たりませんでした」と言わない。**
 *   当たってはいるので、そう言うと嘘になる。代わりに件数と出し方を言う
 * - **中止したときも「当たりませんでした」と言わない。** 最後まで見ていないので、
 *   代わりに「全部ではない」と言う
 * - 何件目かは、辿っている 1 件が決まっているときだけ出す
 */
export function searchView(state: SearchState): SearchView {
  const total = state.hits.rows.length;
  const notes: SearchNote[] = [];

  if (state.searched && !state.cancelled && total === 0 && state.hits.hidden === 0) {
    notes.push({ kind: "none" });
  }
  if (state.hits.hidden > 0) notes.push({ kind: "hidden", count: state.hits.hidden });
  if (state.cancelled) notes.push({ kind: "cancelled" });
  notes.push(...state.notices);
  if (state.error !== null) notes.push({ kind: "failed", detail: state.error });

  const timing = state.running ? state.timing : null;
  return {
    canStep: total > 0,
    position:
      total > 0 && state.current >= 0 && state.current < total
        ? { current: state.current + 1, total }
        : null,
    canClear: state.searched || state.input !== "" || notes.length > 0,
    canCancel: timing !== null,
    progress: timing === null ? null : searchProgress(timing.estimateSeconds, timing.elapsedMs),
    notes,
  };
}
