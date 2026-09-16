/**
 * コミット検索の状態（T-35。docs/DESIGN.md §6.6）。
 *
 * **判定はここに書かない。** 打ったことばの解釈は `lib/commitQuery.ts`、
 * 当たりを行に落とすのは `lib/commitSearch.ts` で、どちらも純関数（CLAUDE.md §8）。
 * ここがやるのは、それらを呼ぶ順番と、呼んだ結果の保持だけ。
 *
 * **探すのは押されたときだけ。** 打つたびに git を走らせない。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { planSearch, type QueryNotice } from "../lib/commitQuery";
import {
  hitAfter,
  hitsIn,
  NO_HITS,
  rowOf,
  stepHit,
  type SearchHits,
} from "../lib/commitSearch";
import { searchCommits } from "../lib/ipc";

/** 行へ飛ばす合図。**連番が変わったときだけ動く**（`jumpTo` と同じ作り）。 */
export type SearchFocus = { row: number; nonce: number };

export type CommitSearch = {
  input: string;
  setInput: (value: string) => void;
  /** 探す。空欄なら「まだ何も探していない」に戻すだけ。 */
  run: () => void;
  /** 探すのをやめる（欄も結果も空にする）。 */
  clear: () => void;
  running: boolean;
  /** 一度でも探したか。**0 件と「まだ探していない」を分けるため。** */
  searched: boolean;
  hits: SearchHits;
  /** いま見ている当たりの番号（`hits.rows` の添字）。1 件も無ければ -1。 */
  current: number;
  step: (delta: number) => void;
  focus: SearchFocus | null;
  notices: QueryNotice[];
  /** `code:` が打たれた。**T-35 ではまだ探せない**ので断る。 */
  codeUnsupported: boolean;
  error: string | null;
};

export function useCommitSearch(
  repositoryId: string,
  /** 表示している並びの SHA。**`LaneLayout.rows` から作ったものを渡すこと。** */
  shownShas: readonly string[],
  /** いま選んでいる行。探した直後にどの当たりへ行くかを決めるのに使う。 */
  selectedRow: number | null,
): CommitSearch {
  const [input, setInput] = useState("");
  /** 当たった SHA。**`null` はまだ探していない**（空配列は「0 件だった」）。 */
  const [shas, setShas] = useState<string[] | null>(null);
  const [notices, setNotices] = useState<QueryNotice[]>([]);
  const [codeUnsupported, setCodeUnsupported] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(-1);
  const [focus, setFocus] = useState<SearchFocus | null>(null);

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
  useEffect(() => {
    shownRef.current = shownShas;
  }, [shownShas]);
  useEffect(() => {
    selectedRef.current = selectedRow;
  }, [selectedRow]);

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
    request.current += 1;
    setRunning(false);
    setShas(null);
    setNotices([]);
    setCodeUnsupported(false);
    setError(null);
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
    setCodeUnsupported(plan.kind === "refuse");

    if (plan.kind !== "search") {
      setShas(null);
      goTo(-1, NO_HITS);
      return;
    }

    request.current += 1;
    const mine = request.current;
    setRunning(true);
    void searchCommits(repositoryId, plan.query)
      .then((outcome) => {
        if (mine !== request.current) return;
        setShas(outcome.shas);
        const found = hitsIn(shownRef.current, outcome.shas);
        goTo(hitAfter(found, selectedRef.current), found);
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
  }, [goTo, input, repositoryId]);

  const clear = useCallback(() => {
    setInput("");
    reset();
  }, [reset]);

  const step = useCallback(
    (delta: number) => goTo(stepHit(hits.rows.length, current, delta), hits),
    [current, goTo, hits],
  );

  return {
    input,
    setInput,
    run,
    clear,
    running,
    searched: shas !== null,
    hits,
    current,
    step,
    focus,
    notices,
    codeUnsupported,
    error,
  };
}
