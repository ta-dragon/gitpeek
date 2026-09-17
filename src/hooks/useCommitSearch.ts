/**
 * コミット検索の状態（T-35 / T-36。docs/DESIGN.md §6.6）。
 *
 * **判定はここに書かない。** 打ったことばの解釈は `lib/commitQuery.ts`、
 * 当たりを行に落とすこと・目安の見積もり・表示の出し分けは `lib/commitSearch.ts` で、
 * どれも純関数（CLAUDE.md §8）。ここがやるのは、それらを呼ぶ順番と結果の保持だけ。
 *
 * **探すのは押されたときだけ。** 打つたびに git を走らせない。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { planSearch, type QueryNotice } from "../lib/commitQuery";
import {
  estimateSeconds,
  hitAfter,
  hitsIn,
  learnedRate,
  NO_HITS,
  rowOf,
  stepHit,
  type SearchHits,
  type SearchState,
} from "../lib/commitSearch";
import { cancelCommitSearch, searchCommits } from "../lib/ipc";
import { currentUiState, updateRepositoryUiState } from "../store/uiState";

/** 経過時間を描き直す間隔。秒単位でしか出さないので、これより細かくしても変わらない。 */
const TICK_MS = 500;

/** 行へ飛ばす合図。**連番が変わったときだけ動く**（`jumpTo` と同じ作り）。 */
export type SearchFocus = { row: number; nonce: number };

export type CommitSearch = SearchState & {
  setInput: (value: string) => void;
  /** 探す。空欄なら「まだ何も探していない」に戻すだけ。 */
  run: () => void;
  /** 探すのをやめる（欄も結果も空にする。走っていれば止める）。 */
  clear: () => void;
  /** 走っている検索を止める。**そこまでの当たりは残す。** */
  cancel: () => void;
  step: (delta: number) => void;
  focus: SearchFocus | null;
};

export function useCommitSearch(
  repositoryId: string,
  /** 表示している並びの SHA。**`LaneLayout.rows` から作ったものを渡すこと。** */
  shownShas: readonly string[],
  /** いま選んでいる行。探した直後にどの当たりへ行くかを決めるのに使う。 */
  selectedRow: number | null,
  /**
   * 読み込んだコミットの総数（**可視 ref で絞る前**）。git が見るのはこの全部なので、
   * 目安の見積もりにはこちらを使う。
   */
  commitCount: number,
): CommitSearch {
  const [input, setInput] = useState("");
  /** 当たった SHA。**`null` はまだ探していない**（空配列は「0 件だった」）。 */
  const [shas, setShas] = useState<string[] | null>(null);
  const [notices, setNotices] = useState<QueryNotice[]>([]);
  const [running, setRunning] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(-1);
  const [focus, setFocus] = useState<SearchFocus | null>(null);
  /** コード内容を探している間の計時。メッセージと作者だけのときは `null`。 */
  const [clock, setClock] = useState<{ estimateSeconds: number; startedAt: number } | null>(
    null,
  );
  const [now, setNow] = useState(() => Date.now());

  // 当たりは行の並びから毎回引き直す。絞り込みや並び順を変えても印がずれない。
  const hits = useMemo(
    () => (shas === null ? NO_HITS : hitsIn(shownShas, shas)),
    [shas, shownShas],
  );

  // 探し終わった時点の並びと選択行を見たいので、値ではなく写しを持つ。
  const shownRef = useRef(shownShas);
  const selectedRef = useRef(selectedRow);
  const nonce = useRef(0);
  /**
   * 直近の要求だけを採るための番号（`store/snapshot.ts` と同じ作り）。
   * 探している途中でリポジトリを切り替えると、**前のリポジトリの結果が後から届いて
   * 印が付く**。やめたときと切り替えたときにも進めて、遅れて来た応答を捨てる。
   */
  const request = useRef(0);
  /** いま走っているか（`reset` から見るための写し）。 */
  const runningRef = useRef(false);
  useEffect(() => {
    shownRef.current = shownShas;
  }, [shownShas]);
  useEffect(() => {
    selectedRef.current = selectedRow;
  }, [selectedRow]);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  // 計時。**走っている間だけ**時計を進める。
  useEffect(() => {
    if (!running || clock === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [running, clock]);

  const goTo = useCallback((next: number, found: SearchHits) => {
    setCurrent(next);
    const row = rowOf(found, next);
    if (row === null) {
      setFocus(null);
      return;
    }
    nonce.current += 1;
    setFocus({ row, nonce: nonce.current });
  }, []);

  const reset = useCallback(() => {
    // 走っていたら止める。**画面が見なくなった検索に CPU を使わせない。**
    if (runningRef.current) void cancelCommitSearch().catch(() => undefined);
    request.current += 1;
    setRunning(false);
    setShas(null);
    setNotices([]);
    setCancelled(false);
    setError(null);
    setClock(null);
    setCurrent(-1);
    setFocus(null);
  }, []);

  // リポジトリを切り替えたら結果を捨てる。**前のリポジトリの SHA に印が付いたままになる。**
  useEffect(() => {
    setInput("");
    reset();
  }, [repositoryId, reset]);

  const run = useCallback(() => {
    // **何をするかは `planSearch` が決める。** ここに分岐の理由を書かない。
    const plan = planSearch(input);
    setNotices(plan.notices);
    setError(null);
    setCancelled(false);

    if (plan.kind !== "search") {
      setShas(null);
      setClock(null);
      goTo(-1, NO_HITS);
      return;
    }

    const rate = currentUiState().perRepository[repositoryId]?.codeSearchRate ?? null;
    setClock(
      plan.slow
        ? { estimateSeconds: estimateSeconds(commitCount, rate), startedAt: Date.now() }
        : null,
    );

    request.current += 1;
    const mine = request.current;
    setRunning(true);
    void searchCommits(repositoryId, plan.query)
      .then((outcome) => {
        if (mine !== request.current) return;
        setShas(outcome.shas);
        setCancelled(outcome.cancelled);
        const found = hitsIn(shownRef.current, outcome.shas);
        goTo(hitAfter(found, selectedRef.current), found);

        // 次の目安のために覚える。**覚えてよいかは `learnedRate` が決める。**
        const learned = learnedRate(plan.query, outcome, commitCount);
        if (learned !== null) {
          updateRepositoryUiState(repositoryId, (state) => ({
            ...state,
            codeSearchRate: learned,
          }));
        }
      })
      .catch((reason: unknown) => {
        if (mine !== request.current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setShas(null);
        goTo(-1, NO_HITS);
      })
      .finally(() => {
        if (mine === request.current) setRunning(false);
      });
  }, [commitCount, goTo, input, repositoryId]);

  const clear = useCallback(() => {
    setInput("");
    reset();
  }, [reset]);

  const cancel = useCallback(() => {
    // 結果は `searchCommits` の応答（`cancelled: true`）で届く。ここでは合図を送るだけ。
    void cancelCommitSearch().catch(() => undefined);
  }, []);

  const step = useCallback(
    (delta: number) => goTo(stepHit(hits.rows.length, current, delta), hits),
    [current, goTo, hits],
  );

  return {
    input,
    setInput,
    run,
    clear,
    cancel,
    running,
    searched: shas !== null,
    hits,
    current,
    step,
    focus,
    notices,
    cancelled,
    error,
    timing:
      clock === null
        ? null
        : { estimateSeconds: clock.estimateSeconds, elapsedMs: Math.max(0, now - clock.startedAt) },
  };
}
