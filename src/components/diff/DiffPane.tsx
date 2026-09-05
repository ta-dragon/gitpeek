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
  type DiffSource,
  type FileChange,
  type FileDiff,
  type Finding,
  type TextEncoding,
  type UiSettings,
} from "../../lib/ipc";
import { CollapsedNotice } from "./CollapsedNotice";
import { DiffBody } from "./DiffBody";
import { DiffToolbar } from "./DiffToolbar";
import { UntrackedFile } from "./UntrackedFile";

type Props = {
  repositoryId: string;
  /**
   * 何と何の差分か。**呼び出し側が決める**（コミット / 2 点比較 / 作業ツリー）。
   * `null` なら何も選ばれていない。
   */
  source: DiffSource | null;
  /** 選択中のファイル。差分を持たないもの（未追跡・衝突）は `null`。 */
  change: FileChange | null;
  /** 未追跡ファイルを選んでいるときのパス。**差分ではなく全文**を出す。 */
  untrackedPath: string | null;
  /** 衝突しているファイルを選んでいるときのパス。 */
  conflictPath: string | null;
  /** `Enter` でフォーカスを移す先。 */
  bodyRef: React.RefObject<HTMLDivElement | null>;
  ui: UiSettings;
  /**
   * このファイルに付いた AI レビューの指摘（T-23）。無ければ空。
   *
   * **差分に無い行を指したものは行に付かない**（`lib/reviewFindings.ts` が振り分ける）。
   */
  findings: Finding[];
  onUiChange: (change: Partial<UiSettings>) => void;
};

export function DiffPane({
  repositoryId,
  source,
  change,
  untrackedPath,
  conflictPath,
  bodyRef,
  ui,
  findings,
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

  const sourceKey = JSON.stringify(source);
  const selectedPath = change?.path ?? untrackedPath ?? conflictPath;

  // ファイルやコミットが変われば上書きは意味を失う。自動判別へ戻し、折りたたみ直す。
  useEffect(() => {
    setForcedEncoding(null);
    setExpanded(false);
  }, [repositoryId, sourceKey, selectedPath]);

  useEffect(() => {
    const request = (latest.current += 1);

    if (source === null || change === null) {
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
          source,
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
    // `source` は呼び出しのたびに作り直されるので、素の値（JSON）で比べる。
  }, [
    repositoryId,
    sourceKey,
    change?.path,
    change?.oldPath,
    ui.contextLines,
    ui.ignoreWhitespace,
    forcedEncoding,
    retry,
  ]);

  return (
    // `tabIndex` は `Enter` でここへフォーカスを移すため（キーボードだけで差分へ入れる）。
    <div className="dpane" ref={bodyRef} tabIndex={-1}>
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

      {source !== null && change !== null && (
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
          repositoryId={repositoryId}
          source={source}
          change={change}
          untrackedPath={untrackedPath}
          conflictPath={conflictPath}
          diff={diff}
          loading={loading}
          error={error}
          ui={ui}
          findings={findings}
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
  repositoryId,
  source,
  change,
  untrackedPath,
  conflictPath,
  diff,
  loading,
  error,
  ui,
  findings,
  expanded,
  scrollRef,
  onExpand,
  onRetry,
}: {
  repositoryId: string;
  source: DiffSource | null;
  change: FileChange | null;
  untrackedPath: string | null;
  conflictPath: string | null;
  diff: FileDiff | null;
  loading: boolean;
  error: string | null;
  ui: UiSettings;
  findings: Finding[];
  expanded: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onExpand: () => void;
  onRetry: () => void;
}) {
  // **未追跡は差分にしない**（docs/DESIGN.md §7.5）。全文をそのまま出す。
  if (untrackedPath !== null) {
    return (
      <>
        <p className="dpane__pending">{ja.workingTree.untrackedBody}</p>
        <UntrackedFile repositoryId={repositoryId} path={untrackedPath} />
      </>
    );
  }

  // 衝突は差分にしない。**直す手段を持たない**ので、状態を告げるだけ（CLAUDE.md §1）。
  if (conflictPath !== null) {
    return <p className="dpane__pending">{ja.workingTree.conflictBody}</p>;
  }

  if (source === null) return <p className="dpane__pending">{ja.diff.empty}</p>;
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
      findings={findings}
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
