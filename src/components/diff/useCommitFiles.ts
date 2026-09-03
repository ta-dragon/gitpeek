/**
 * 選択中コミットの詳細と変更ファイル一覧の取得（docs/DESIGN.md §7.3）。
 *
 * **なぜフックに切り出してあるか。** 3 ペインにしたことで、詳細と一覧（右ペイン）と
 * 差分本体（中央下）が別の枝に分かれた。取得はどちらか一方の都合ではないので、
 * 両方を含む `App` の `RepositoryPanel` で 1 回だけ呼び、結果を両側へ配る。
 *
 * 取得は 2 本（`show -s` と `diff --raw --numstat`）。どちらもコミットを選ぶたびに
 * 走るので、**古い応答を捨てる番号**を持つ（素早く上下すると先の要求が後から返る）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  loadChangedFiles,
  loadCommitDetail,
  type CommitDetail,
  type CommitMeta,
  type FileChange,
} from "../../lib/ipc";

/** 参照が毎回変わると一覧が毎回組み直しになる。空のときは同じ配列を使う。 */
const NO_CHANGES: FileChange[] = [];

/**
 * 何を見ているか。**1 点（コミットと親）か、2 点比較か**（docs/DESIGN.md §10.3）。
 *
 * 差分の取得側から見ればどちらも「2 つのリビジョンを比べる」なので、
 * 違いは**親を自分で決めるかどうか**と、コミット詳細を出すかどうかだけ。
 */
export type DiffScope =
  | { kind: "commit"; sha: string }
  | { kind: "compare"; from: string; to: string; symmetric: boolean };

/** 実際に git へ渡した 2 点。`from` が null ならルートコミット（空ツリーとの差分）。 */
export type DiffRange = { from: string | null; to: string; symmetric: boolean };

export type CommitFiles = {
  /** **2 点比較では null**（`show -s` は 1 点のためのもの）。 */
  detail: CommitDetail | null;
  changes: FileChange[];
  loading: boolean;
  error: string | null;
  /** 何番目の親と比べているか（マージのみ意味を持つ）。 */
  parentIndex: number;
  setParentIndex: (index: number) => void;
  /** 親のメタ情報。読み込んだ集合の外にある親は `null`。 */
  parentsInGraph: (CommitMeta | null)[];
  /**
   * 一覧を作ったときに実際に比べた 2 点。**差分本体もこれを使う。**
   * 詳細から組み直すと、読み込み中に一覧と差分が別の組を見ることがある。
   */
  range: DiffRange | null;
  retry: () => void;
  /** `Enter` でフォーカスを移す先（差分本体）に付ける。 */
  bodyRef: React.RefObject<HTMLDivElement | null>;
};

export function useCommitFiles({
  repositoryId,
  scope,
  commits,
  selectedFile,
  onSelectFile,
}: {
  repositoryId: string;
  /** 見ているもの。`null` なら何も選ばれていない。 */
  scope: DiffScope | null;
  /** 読み込んだ全コミット。親の subject を引くために使う（再取得はしない）。 */
  commits: CommitMeta[];
  selectedFile: string | null;
  onSelectFile: (path: string | null) => void;
}): CommitFiles {
  // **依存には素の値を並べる。** `scope` は呼び出しのたびに作り直される
  // オブジェクトなので、そのまま依存に入れると毎回取り直しになる。
  const sha = scope?.kind === "commit" ? scope.sha : null;
  const from = scope?.kind === "compare" ? scope.from : null;
  const to = scope?.kind === "compare" ? scope.to : null;
  const symmetric = scope?.kind === "compare" ? scope.symmetric : false;

  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [range, setRange] = useState<DiffRange | null>(null);
  const [changes, setChanges] = useState<FileChange[]>(NO_CHANGES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 何番目の親と比べているか（マージのみ意味を持つ）。
   *
   * **永続化しない。** 別のコミットへ移れば意味を失う値なので、`state.json` に
   * 残すと「前に開いたマージの第 2 親」が別のコミットに適用されかねない。
   */
  const [parentIndex, setParentIndex] = useState(0);
  /** 「もう一度試す」を押した回数。取得の依存に混ぜて再実行の合図にする。 */
  const [retryCount, setRetryCount] = useState(0);

  const bodyRef = useRef<HTMLDivElement>(null);
  const latest = useRef(0);

  const commitBySha = useMemo(() => {
    const map = new Map<string, CommitMeta>();
    for (const commit of commits) map.set(commit.sha, commit);
    return map;
  }, [commits]);

  // コミットが変わったら親の選択を第 1 親へ戻す（docs/DESIGN.md §7.4）。
  useEffect(() => {
    setParentIndex(0);
  }, [sha, repositoryId]);

  useEffect(() => {
    const request = (latest.current += 1);

    if (sha === null && to === null) {
      setDetail(null);
      setRange(null);
      setChanges(NO_CHANGES);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    void (async () => {
      try {
        // **2 点比較では詳細を取りに行かない。** 親は呼び出し側が決めている。
        const target: DiffRange =
          sha === null
            ? { from, to: to as string, symmetric }
            : await commitRange(repositoryId, sha, parentIndex, setDetail);
        if (request !== latest.current) return;
        if (sha === null) setDetail(null);

        const files = await loadChangedFiles(
          repositoryId,
          target.to,
          target.from,
          target.symmetric,
        );
        if (request !== latest.current) return;

        setRange(target);
        setChanges(files.length === 0 ? NO_CHANGES : files);
        setLoading(false);
      } catch (caught) {
        if (request !== latest.current) return;
        setDetail(null);
        setRange(null);
        setChanges(NO_CHANGES);
        setLoading(false);
        setError(messageOf(caught));
      }
    })();
  }, [repositoryId, sha, from, to, symmetric, parentIndex, retryCount]);

  // 選択ファイルが今の一覧に無ければ先頭へ寄せる。コミットを移ると前のファイルは
  // たいてい変更されていないので、毎回「選択なし」になるより先頭が出るほうが速い。
  useEffect(() => {
    if (changes.length === 0) return;
    if (selectedFile !== null && changes.some((change) => change.path === selectedFile)) return;
    onSelectFile(changes[0].path);
    // **依存は `changes` だけ。** `onSelectFile` と `selectedFile` を入れると、
    // 選択を書き戻すたびにこの効果が回って往復する。
  }, [changes]);

  const step = useCallback(
    (delta: number) => {
      if (changes.length === 0) return;
      const current = changes.findIndex((change) => change.path === selectedFile);
      const next = Math.min(changes.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta));
      onSelectFile(changes[next].path);
    },
    [changes, selectedFile, onSelectFile],
  );

  // `Alt+↑` / `Alt+↓` で前 / 次のファイル、`Enter` で差分ペインへフォーカス
  // （docs/DESIGN.md §6.5。T-07 で保留していた 3 つ）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // 入力欄では横取りしない（SHA ジャンプ欄で Enter が効かなくなる）。
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          step(-1);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          step(1);
        }
        return;
      }

      if (event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const element = bodyRef.current;
        if (element === null) return;
        event.preventDefault();
        element.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [step]);

  const parentsInGraph = useMemo(
    () => (detail?.parents ?? []).map((parent) => commitBySha.get(parent) ?? null),
    [detail, commitBySha],
  );

  const retry = useCallback(() => {
    setError(null);
    setRetryCount((count) => count + 1);
  }, []);

  return {
    detail,
    changes,
    loading,
    error,
    parentIndex,
    setParentIndex,
    parentsInGraph,
    range,
    retry,
    bodyRef,
  };
}

/**
 * 1 点のときの「比べる 2 点」を決める。**詳細を取ってからでないと親が分からない。**
 *
 * ルートコミットは親が無いので `from` が null になり、空ツリーとの差分になる。
 * 指定された番号の親が無ければ第 1 親に落とす（親の数はコミットごとに違う）。
 */
async function commitRange(
  repositoryId: string,
  sha: string,
  parentIndex: number,
  setDetail: (detail: CommitDetail) => void,
): Promise<DiffRange> {
  const detail = await loadCommitDetail(repositoryId, sha);
  setDetail(detail);

  return {
    from: detail.parents[parentIndex] ?? detail.parents[0] ?? null,
    to: sha,
    symmetric: false,
  };
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : String(error);
}
