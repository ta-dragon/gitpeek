/**
 * 差分本体のツールバー（docs/DESIGN.md §7.2, §9）。
 *
 * 表示の切替は**設定として残す**（`settings.json` の `ui`）。毎回選び直したくないため。
 * **文字コードの手動上書きだけは残さない** — ファイルごとの判断なので、
 * 別のファイルへ持ち越すと黙って化ける。
 */
import { ja } from "../../i18n/ja";
import {
  ALL_CONTEXT_LINES,
  type FileDiff,
  type TextEncoding,
  type UiSettings,
} from "../../lib/ipc";

/** 前後に出す行数の選択肢。「すべて」は十分大きな `-U` で代用する。 */
const CONTEXT_CHOICES = [0, 3, 10, 25, ALL_CONTEXT_LINES];

const ENCODINGS: TextEncoding[] = ["utf8", "shiftJis", "eucJp"];

export function DiffToolbar({
  diff,
  layout,
  contextLines,
  ignoreWhitespace,
  showLineEndings,
  forcedEncoding,
  onLayoutChange,
  onContextLinesChange,
  onIgnoreWhitespaceChange,
  onShowLineEndingsChange,
  onForcedEncodingChange,
}: {
  /** 読み込み中は `null`。切替そのものは読み込み中でもできる。 */
  diff: FileDiff | null;
  layout: UiSettings["diffLayout"];
  contextLines: number;
  ignoreWhitespace: boolean;
  showLineEndings: boolean;
  forcedEncoding: TextEncoding | null;
  onLayoutChange: (layout: UiSettings["diffLayout"]) => void;
  onContextLinesChange: (lines: number) => void;
  onIgnoreWhitespaceChange: (ignore: boolean) => void;
  onShowLineEndingsChange: (show: boolean) => void;
  onForcedEncodingChange: (encoding: TextEncoding | null) => void;
}) {
  return (
    <div className="dbar">
      <label className="dbar__field">
        {ja.diff.viewLabel}
        <select
          className="select select--small"
          value={layout}
          onChange={(event) =>
            onLayoutChange(event.target.value as UiSettings["diffLayout"])
          }
        >
          <option value="side-by-side">{ja.diff.layoutSideBySide}</option>
          <option value="unified">{ja.diff.layoutUnified}</option>
        </select>
      </label>

      <label className="dbar__field">
        {ja.diff.contextLabel}
        <select
          className="select select--small"
          value={contextLines}
          onChange={(event) => onContextLinesChange(Number(event.target.value))}
        >
          {CONTEXT_CHOICES.map((lines) => (
            <option key={lines} value={lines}>
              {lines === ALL_CONTEXT_LINES ? ja.diff.contextAll : ja.diff.contextLines(lines)}
            </option>
          ))}
        </select>
      </label>

      <label className="dbar__check" title={ja.diff.ignoreWhitespaceHint}>
        <input
          type="checkbox"
          checked={ignoreWhitespace}
          onChange={(event) => onIgnoreWhitespaceChange(event.target.checked)}
        />
        {ja.diff.ignoreWhitespace}
      </label>

      <label className="dbar__check">
        <input
          type="checkbox"
          checked={showLineEndings}
          onChange={(event) => onShowLineEndingsChange(event.target.checked)}
        />
        {ja.diff.showLineEndings}
      </label>

      <div className="app__spacer" />

      {/*
       * 文字コードは**判別結果を出したうえで上書きできる**（docs/DESIGN.md §9.1）。
       * 判別は順序で決めているので当たらないことがあり、この選択が唯一の逃げ道になる。
       */}
      <label className="dbar__field" title={ja.diff.encodingHint}>
        {ja.diff.encodingLabel}
        <select
          className="select select--small"
          value={forcedEncoding ?? "auto"}
          onChange={(event) =>
            onForcedEncodingChange(
              event.target.value === "auto" ? null : (event.target.value as TextEncoding),
            )
          }
        >
          <option value="auto">
            {diff === null
              ? ja.diff.encodingAutoUnknown
              : ja.diff.encodingAuto(ja.diff.encodingNames[diff.encoding])}
          </option>
          {ENCODINGS.map((encoding) => (
            <option key={encoding} value={encoding}>
              {ja.diff.encodingNames[encoding]}
            </option>
          ))}
        </select>
      </label>

      {diff?.lossy === true && (
        <span className="dbar__warn" title={ja.diff.lossyHint}>
          {ja.diff.lossy}
        </span>
      )}

      {/* 改行コードは常時表示（§9.2）。混在は警告にする。 */}
      {diff !== null && !diff.binary && (
        <span
          className={diff.mixedLineEndings ? "dbar__warn" : "dbar__status"}
          title={
            diff.mixedLineEndings
              ? ja.diff.lineEndingMixedHint(
                  diff.lineEndings.lf,
                  diff.lineEndings.crlf,
                  diff.lineEndings.cr,
                )
              : ja.diff.lineEndingHint
          }
        >
          {diff.mixedLineEndings
            ? ja.diff.lineEndingMixed
            : diff.dominantLineEnding === null
              ? ja.diff.lineEndingNone
              : ja.diff.lineEndingNames[diff.dominantLineEnding]}
        </span>
      )}
    </div>
  );
}
