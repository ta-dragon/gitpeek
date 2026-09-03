/**
 * 差分ペイン（docs/DESIGN.md §7.3）。
 *
 * 3 段構成: コミット詳細 → 変更ファイル一覧 → 選択ファイルの差分。
 * **3 段目の中身は T-13 で入る**ので、いまは器だけ置く。
 *
 * 取得は 2 本（`show -s` と `diff --raw --numstat`）。どちらもコミットを選ぶたびに
 * 走るので、**古い応答を捨てる番号**を持つ（素早く上下すると先の要求が後から返る）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ja } from "../../i18n/ja";
import {
  loadChangedFiles,
  loadCommitDetail,
  type CommitDetail as Detail,
  type CommitMeta,
  type FileChange,
} from "../../lib/ipc";
import { CommitDetail } from "./CommitDetail";
import { FileList, type FileListLayout } from "./FileList";

type Props = {
  repositoryId: string;
  /** 選択中のコミット。`state.json` の `selectedCommit` が正（T-07 からの申し送り）。 */
  sha: string | null;
  /** 読み込んだ全コミット。親の subject を引くために使う（再取得はしない）。 */
  commits: CommitMeta[];
  selectedFile: string | null;
  onSelectFile: (path: string | null) => void;
  /** コピーの結果など、短い通知を出す。 */
  onNotice: (message: string) => void;
};

export function DiffPane({
  repositoryId,
  sha,
  commits,
  selectedFile,
  onSelectFile,
  onNotice,
}: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [changes, setChanges] = useState<FileChange[]>(NO_CHANGES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [layout, setLayout] = useState<FileListLayout>("flat");
  /**
   * 何番目の親と比べているか（マージのみ意味を持つ）。
   *
   * **永続化しない。** 別のコミットへ移れば意味を失う値なので、`state.json` に
   * 残すと「前に開いたマージの第 2 親」が別のコミットに適用されかねない。
   */
  const [parentIndex, setParentIndex] = useState(0);
  /** 「もう一度試す」を押した回数。取得の依存に混ぜて再実行の合図にする。 */
  const [retry, setRetry] = useState(0);

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

    if (sha === null) {
      setDetail(null);
      setChanges(NO_CHANGES);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const loaded = await loadCommitDetail(repositoryId, sha);
        if (request !== latest.current) return;
        setDetail(loaded);

        // ルートコミットは親が無い。null を渡すと空ツリーとの差分になる。
        const parent = loaded.parents[parentIndex] ?? loaded.parents[0] ?? null;
        const files = await loadChangedFiles(repositoryId, sha, parent);
        if (request !== latest.current) return;

        setChanges(files.length === 0 ? NO_CHANGES : files);
        setLoading(false);
      } catch (caught) {
        if (request !== latest.current) return;
        setDetail(null);
        setChanges(NO_CHANGES);
        setLoading(false);
        setError(messageOf(caught));
      }
    })();
  }, [repositoryId, sha, parentIndex, retry]);

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

  if (sha === null) {
    return (
      <div className="dpane dpane--empty">
        <p>{ja.diff.empty}</p>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="dpane dpane--empty">
        <p className="dpane__error">{ja.diff.failed}</p>
        <p className="dpane__detail">{error}</p>
        <button
          type="button"
          className="button"
          onClick={() => {
            setError(null);
            setRetry((count) => count + 1);
          }}
        >
          {ja.diff.retry}
        </button>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="dpane dpane--empty">
        <p>{ja.diff.loading}</p>
      </div>
    );
  }

  return (
    // `tabIndex` は `Enter` でここへフォーカスを移すため（キーボードだけで差分へ入れる）。
    <div className="dpane" ref={bodyRef} tabIndex={-1}>
      <CommitDetail
        detail={detail}
        parentIndex={parentIndex}
        parentsInGraph={detail.parents.map((parent) => commitBySha.get(parent) ?? null)}
        onParentChange={setParentIndex}
        onCopySha={(text) => void copyText(text, onNotice)}
      />

      <FileList
        changes={changes}
        selectedPath={selectedFile}
        layout={layout}
        onSelect={onSelectFile}
        onLayoutChange={setLayout}
      />

      {/* 3 段目。T-13 で差分本体が入る。 */}
      <div className="dpane__body">
        <p className="dpane__pending">
          {selectedFile === null ? ja.diff.selectFile : ja.diff.bodyPending}
        </p>
        {loading && <p className="dpane__detail">{ja.diff.loading}</p>}
      </div>
    </div>
  );
}

/** 参照が毎回変わると一覧が毎回組み直しになる。空のときは同じ配列を使う。 */
const NO_CHANGES: FileChange[] = [];

/**
 * クリップボードへ書く（`RefTree` と同じ理由でプラグインを入れない）。
 * 失敗したときは黙らず通知する。
 */
async function copyText(text: string, onNotice: (message: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    onNotice(ja.diff.copied(text));
  } catch {
    onNotice(ja.diff.copyFailed);
  }
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : String(error);
}
