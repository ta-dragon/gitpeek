/**
 * 中央下の差分ペイン（docs/DESIGN.md §7.2, §7.3）。
 *
 * **ここは差分本体だけ**を出す。コミット詳細と変更ファイル一覧は右ペイン
 * （`CommitInfo`）にある。
 *
 * 差分の取得はここが持つ（一覧の取得とは別物で、**選んだファイルの分だけ**取りに行く）。
 * hunk へのパースと文字コード判別は Rust 側（`git/diff.rs`）で済んでいる。
 */
import { useEffect, useRef, useState } from "react";

import { ja } from "../../i18n/ja";
import { formatBytes, measureDiff, shouldCollapse } from "../../lib/diffRows";
import {
  loadFileDiff,
  type FileChange,
  type FileDiff,
  type TextEncoding,
  type UiSettings,
} from "../../lib/ipc";
import { CollapsedNotice } from "./CollapsedNotice";
import { DiffBody } from "./DiffBody";
import { DiffToolbar } from "./DiffToolbar";
import type { CommitFiles } from "./useCommitFiles";

type Props = {
  repositoryId: string;
  sha: string | null;
  selectedFile: string | null;
  files: CommitFiles;
  ui: UiSettings;
  onUiChange: (change: Partial<UiSettings>) => void;
};

export function DiffPane({
  repositoryId,
  sha,
  selectedFile,
  files,
  ui,
  onUiChange,
}: Props) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 文字コードの手動上書き。**永続化しない。**
   * ファイルごとの判断なので、別のファイルへ持ち越すと黙って化ける。
   */
  const [forcedEncoding, setForcedEncoding] = useState<TextEncoding | null>(null);
  const [retry, setRetry] = useState(0);
  /**
   * 大きな差分を明示的に開いたか。**永続化せず、ファイルを移ったら畳み直す**
   * （文字コードの上書きと同じ理由 — ファイルごとの判断なので持ち越さない）。
   */
  const [expanded, setExpanded] = useState(false);

  const latest = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  const change: FileChange | null =
    files.changes.find((entry) => entry.path === selectedFile) ?? null;
  // ルートコミットは親が無い。`null` が「空ツリーとの差分」を意味する。
  const parent = files.detail?.parents[files.parentIndex] ?? null;

  // ファイルやコミットが変われば上書きは意味を失う。自動判別へ戻し、折りたたみ直す。
  useEffect(() => {
    setForcedEncoding(null);
    setExpanded(false);
  }, [repositoryId, sha, selectedFile]);

  useEffect(() => {
    const request = (latest.current += 1);

    if (sha === null || change === null) {
      setDiff(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const loaded = await loadFileDiff({
          repositoryId,
          sha,
          parent,
          path: change.path,
          // **リネームでは古いパスも渡す。** 渡さないと git がリネームを検出できず、
          // 全行が追加された新規ファイルとして返る。
          oldPath: change.oldPath,
          contextLines: ui.contextLines,
          ignoreWhitespace: ui.ignoreWhitespace,
          forcedEncoding,
        });
        if (request !== latest.current) return;
        setDiff(loaded);
        setLoading(false);
      } catch (caught) {
        if (request !== latest.current) return;
        setDiff(null);
        setLoading(false);
        setError(messageOf(caught));
      }
    })();
    // `change` そのものではなくパスを見る（一覧を取り直すたびに再取得しない）。
  }, [
    repositoryId,
    sha,
    parent,
    change?.path,
    change?.oldPath,
    ui.contextLines,
    ui.ignoreWhitespace,
    forcedEncoding,
    retry,
  ]);

  return (
    // `tabIndex` は `Enter` でここへフォーカスを移すため（キーボードだけで差分へ入れる）。
    <div className="dpane" ref={files.bodyRef} tabIndex={-1}>
      {change !== null && (
        <header className="dpane__head">
          <span className="dpane__path">{change.path}</span>
          <span className="dpane__aside">{ja.diff.statusName[change.status]}</span>
          {change.oldPath !== null && (
            <span className="dpane__aside">{ja.diff.renamedFrom(change.oldPath)}</span>
          )}
          {/* モードとシンボリックリンクは一覧の情報で分かる。git を呼び直さない。 */}
          {isSymlink(change) && <span className="dpane__aside">{ja.diff.symlink}</span>}
          {modeChanged(change) && (
            <span className="dpane__aside">
              {ja.diff.modeChanged(change.oldMode, change.newMode)}
            </span>
          )}
        </header>
      )}

      {sha !== null && change !== null && (
        <DiffToolbar
          diff={diff}
          layout={ui.diffLayout}
          contextLines={ui.contextLines}
          ignoreWhitespace={ui.ignoreWhitespace}
          showLineEndings={ui.showLineEndings}
          forcedEncoding={forcedEncoding}
          onLayoutChange={(diffLayout) => onUiChange({ diffLayout })}
          onContextLinesChange={(contextLines) => onUiChange({ contextLines })}
          onIgnoreWhitespaceChange={(ignoreWhitespace) => onUiChange({ ignoreWhitespace })}
          onShowLineEndingsChange={(showLineEndings) => onUiChange({ showLineEndings })}
          onForcedEncodingChange={setForcedEncoding}
        />
      )}

      <div className="dpane__body" ref={bodyRef}>
        <Body
          sha={sha}
          change={change}
          diff={diff}
          loading={loading}
          error={error}
          ui={ui}
          expanded={expanded}
          scrollRef={bodyRef}
          onExpand={() => setExpanded(true)}
          onRetry={() => {
            setError(null);
            setRetry((count) => count + 1);
          }}
        />
      </div>
    </div>
  );
}

function Body({
  sha,
  change,
  diff,
  loading,
  error,
  ui,
  expanded,
  scrollRef,
  onExpand,
  onRetry,
}: {
  sha: string | null;
  change: FileChange | null;
  diff: FileDiff | null;
  loading: boolean;
  error: string | null;
  ui: UiSettings;
  expanded: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onExpand: () => void;
  onRetry: () => void;
}) {
  if (sha === null) return <p className="dpane__pending">{ja.diff.empty}</p>;
  if (change === null) return <p className="dpane__pending">{ja.diff.selectFile}</p>;

  if (error !== null) {
    return (
      <div className="dpane__notice">
        <p className="dpane__error">{ja.diff.diffFailed}</p>
        <p className="dpane__detail">{error}</p>
        <button type="button" className="button" onClick={onRetry}>
          {ja.diff.retry}
        </button>
      </div>
    );
  }

  // 読み込み中は前のファイルの差分を出したままにしない（別のファイルに見える）。
  if (diff === null || loading) return <p className="dpane__pending">{ja.diff.loading}</p>;

  if (diff.binary) {
    return (
      <div className="dpane__notice">
        <p className="dpane__pending">{ja.diff.binaryBody}</p>
        {/* 行数の代わりにサイズの変化を出す（docs/DESIGN.md §7.2）。 */}
        <p className="dpane__detail">
          {ja.diff.binarySize(sizeText(diff.oldSize), sizeText(diff.newSize))}
        </p>
      </div>
    );
  }

  // リネームやモード変更だけの差分。エラーではない。
  if (diff.hunks.length === 0) return <p className="dpane__pending">{ja.diff.noHunks}</p>;

  // **測るだけなら安い。** 重いのはこの後の行の対応付け・語単位差分・ハイライトなので、
  // 折りたたむと決めたらそこへ進まない。
  const size = measureDiff(diff.hunks);
  if (!expanded && shouldCollapse(size, ui)) {
    return <CollapsedNotice size={size} onExpand={onExpand} />;
  }

  return (
    <DiffBody
      path={diff.path}
      hunks={diff.hunks}
      layout={ui.diffLayout}
      showLineEndings={ui.showLineEndings}
      scrollRef={scrollRef}
    />
  );
}

/** 片側が無いバイナリは「なし」。**0 と書くと「空になった」に読める。** */
function sizeText(bytes: number | null): string {
  return bytes === null ? ja.diff.sizeUnknown : formatBytes(bytes);
}

/** シンボリックリンクのモードは `120000`。追加・削除では片側が `000000` になる。 */
function isSymlink(change: FileChange): boolean {
  return change.oldMode === "120000" || change.newMode === "120000";
}

function modeChanged(change: FileChange): boolean {
  return (
    change.oldMode !== change.newMode &&
    change.oldMode !== "000000" &&
    change.newMode !== "000000"
  );
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : String(error);
}
