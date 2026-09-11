/**
 * 中央下の差分ペイン（docs/DESIGN.md §7.2, §7.3）。
 *
 * **ここは差分本体だけ**を出す。コミット詳細と変更ファイル一覧は右ペイン
 * （`CommitInfo`）にある。
 *
 * 差分の取得はここが持つ（一覧の取得とは別物で、**選んだファイルの分だけ**取りに行く）。
 * hunk へのパースと文字コード判別は Rust 側（`git/diff.rs`）で済んでいる。
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { ja } from "../../i18n/ja";
import {
  buildRows,
  formatBytes,
  measureDiff,
  shouldCollapse,
  type DiffRow,
} from "../../lib/diffRows";
import { hitRows, rowOf, searchRows, stepHit, totalHits } from "../../lib/diffSearch";
import { isTyping, matches } from "../../lib/shortcuts";
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
import { DiffSearchBar } from "./DiffSearchBar";
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
  /**
   * `Enter` でフォーカスを移す先。**外枠の `.dpane` にだけ付ける**（`tabIndex` を持つのはここ）。
   *
   * **仮想スクロールに渡さない。** スクロールするのは内側の `.dpane__body` で、そちらは
   * このペインが自前の `scrollRef` で持つ（docs/DESIGN.md §17.1）。
   */
  focusRef: React.RefObject<HTMLDivElement | null>;
  ui: UiSettings;
  /**
   * このファイルに付いた AI レビューの指摘（T-23）。無ければ空。
   *
   * **差分に無い行を指したものは行に付かない**（`lib/reviewFindings.ts` が振り分ける）。
   */
  findings: Finding[];
  /**
   * 指摘から飛んできた行（利用者の要望。2026-09-06）。
   *
   * **開いているファイルと違うものは渡ってこない**（呼び出し側がパスで見る）。
   */
  jumpTo: { path: string; line: number; nonce: number } | null;
  /**
   * 差分を読み終えたことを伝える。**ドロワーが「当たらなかった指摘」を明記する**のに
   * 要る（CLAUDE.md §6）。読めていないあいだは `null`。
   */
  onDiffLoaded: (diff: FileDiff | null) => void;
  onUiChange: (change: Partial<UiSettings>) => void;
};

export function DiffPane({
  repositoryId,
  source,
  change,
  untrackedPath,
  conflictPath,
  focusRef,
  ui,
  findings,
  jumpTo,
  onDiffLoaded,
  onUiChange,
}: Props) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 差分本体のスクロール要素（`.dpane__body`）。**仮想スクロールはこれを見張る。**
   *
   * **`focusRef` と共有しない。** 1 本の ref を外枠と内側の両方に付けると、React は
   * 親を後から付けるので**スクロールしない外枠が勝ち**、描く行が先頭の数十行で固まる
   * （スクロールはできるのに、その先が空になる。2026-09-12 に踏んだ。docs/DESIGN.md §17.1）。
   */
  const scrollRef = useRef<HTMLDivElement>(null);
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

  /**
   * 差分の中の検索（T-25。`Ctrl+F`）。**開いているファイルの中だけ。**
   *
   * 当たりの判定は純関数（`lib/diffSearch.ts`）。ここが持つのは
   * 「開いているか」「何を打ったか」「いま何番目か」だけ。
   */
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hitIndex, setHitIndex] = useState(-1);
  /** 検索で動かす先。**`nonce` は押した回数**（同じ当たりへもう一度飛べるように）。 */
  const [scrollToRow, setScrollToRow] = useState<{ row: number; nonce: number } | null>(null);

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

  // **読めた差分そのものを上へ渡す。** 行が差分にあるかどうかの判定は
  // 純関数（`lib/reviewFindings.ts`）が行い、ここは配るだけ。
  useEffect(() => {
    onDiffLoaded(loading ? null : diff);
  }, [diff, loading, onDiffLoaded]);

  /**
   * 画面に並べる行。**ここで 1 度だけ組み立てて `DiffBody` へ渡す**
   * （検索も同じ行番号で数えるので、2 か所で組み立てるとずれる）。
   */
  const rows = useMemo(
    () => (diff === null || diff.binary ? [] : buildRows(diff.hunks, ui.diffLayout)),
    [diff, ui.diffLayout],
  );

  /** 畳んであるか。**畳んでいる間は検索しない**（飛ぶ先が画面に無い）。 */
  const collapsed =
    diff !== null && !diff.binary && !expanded && shouldCollapse(measureDiff(diff.hunks), ui);
  const searchable = rows.length > 0 && !collapsed;

  const hits = useMemo(
    () => (searchOpen && searchable ? searchRows(rows, query) : []),
    [searchOpen, searchable, rows, query],
  );
  const total = totalHits(hits);

  // 打ち直したら 1 件目から見る。**当たりが無ければどこにも行かない。**
  useEffect(() => {
    setHitIndex(hits.length > 0 ? 0 : -1);
  }, [hits]);

  // いま見ている当たりの行まで動かす。
  useEffect(() => {
    const row = rowOf(hits, hitIndex);
    if (row === null) return;
    setScrollToRow((current) => ({ row, nonce: (current?.nonce ?? 0) + 1 }));
  }, [hits, hitIndex]);

  // ファイルや対象が変われば、探していたものは意味を失う。
  useEffect(() => {
    setSearchOpen(false);
    setQuery("");
  }, [repositoryId, sourceKey, selectedPath]);

  // `Ctrl+F` で開く（DESIGN.md §6.5）。**入力欄では横取りしない。**
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      if (!matches(event, "findInDiff")) return;
      // **探せないときは開かない**（畳んである・差分が無い）。開くと空の欄が残る。
      if (!searchable) return;
      event.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchable]);

  return (
    // `tabIndex` は `Enter` でここへフォーカスを移すため（キーボードだけで差分へ入れる）。
    <div className="dpane" ref={focusRef} tabIndex={-1}>
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

      {searchOpen && searchable && (
        <DiffSearchBar
          query={query}
          current={hitIndex}
          total={total}
          onQueryChange={setQuery}
          onStep={(delta) => setHitIndex((current) => stepHit(hits.length, current, delta))}
          onClose={() => setSearchOpen(false)}
        />
      )}

      <div className="dpane__body" ref={scrollRef}>
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
          jumpTo={jumpTo}
          rows={rows}
          hits={hitRows(hits)}
          scrollTo={scrollToRow}
          expanded={expanded}
          scrollRef={scrollRef}
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
  jumpTo,
  rows,
  hits,
  scrollTo,
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
  jumpTo: { path: string; line: number; nonce: number } | null;
  /** 並べる行。**組み立ては呼び出し側で 1 度だけ。** */
  rows: DiffRow[];
  /** 検索で当たった行（T-25）。 */
  hits: Set<number>;
  scrollTo: { row: number; nonce: number } | null;
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
      rows={rows}
      layout={ui.diffLayout}
      showLineEndings={ui.showLineEndings}
      findings={findings}
      // **別のファイルの指示は渡さない。** 行番号だけ合ってしまうと別の行へ飛ぶ。
      jumpTo={jumpTo !== null && jumpTo.path === diff.path ? jumpTo : null}
      hits={hits}
      scrollTo={scrollTo}
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
