/**
 * 右の列 — 見ている stash の見出しと変更ファイル（T-42。docs/DESIGN.md §7.5.1）。
 *
 * コミット詳細と同じ場所に出す（作業ツリーを見ているときと同じ扱い）。**親を選ぶドロップダウンは
 * 出さない**（stash はマージコミットだが、index や未追跡だけの親との差分は意味を持たない）。
 * **見るだけ** — 作る・戻す・消す項目は無い（CLAUDE.md §1）。
 */
import { useState } from "react";

import { ja } from "../../i18n/ja";
import type { CommitMeta, StashEntry } from "../../lib/ipc";
import { absoluteTimeDetailed } from "../../lib/relativeTime";
import { stashTitle } from "../../lib/stash";
import { FileList, type FileListLayout } from "./FileList";
import type { StashFiles } from "./useStashFiles";

export function StashInfo({
  entry,
  files,
  base,
  jump,
  onJumpBase,
  onFileHistory,
}: {
  entry: StashEntry;
  files: StashFiles;
  /** 元のコミット。読み込んだ集合の外なら null。 */
  base: CommitMeta | null;
  /** 元のコミットへ移れるか（`lib/stash.ts` の `stashBaseJump`）。 */
  jump: "go" | "hidden" | "outside";
  onJumpBase: () => void;
  onFileHistory: (input: string) => void;
}) {
  const [layout, setLayout] = useState<FileListLayout>("flat");
  const title = stashTitle(entry.message);
  const jumpWhy =
    jump === "outside" ? ja.stash.baseOutside : jump === "hidden" ? ja.stash.baseHidden : null;

  return (
    <div className="cinfo">
      <section className="cdetail">
        <header className="cdetail__head">
          <h2 className="cdetail__subject">
            {title.unnamed && (
              <span className="stash__unnamed" title={ja.stash.unnamedHint}>
                {ja.stash.unnamed}
              </span>
            )}{" "}
            {title.text}
          </h2>
          <span className="cdetail__mono" title={entry.sha}>
            {ja.stash.heading(entry.label)}
          </span>
        </header>

        <dl className="cdetail__facts">
          {title.branch !== null && (
            <>
              <dt>{ja.stash.branch}</dt>
              <dd>{title.branch}</dd>
            </>
          )}
          <dt>{ja.stash.time}</dt>
          <dd>{absoluteTimeDetailed(entry.time)}</dd>
          <dt>{ja.stash.base}</dt>
          <dd>
            <span className="cdetail__mono">{entry.base.slice(0, 8)}</span>{" "}
            {base !== null && <span className="cdetail__aside">{base.subject}</span>}{" "}
            {/* **移れなくても消さず、理由を出す**（CLAUDE.md §6）。 */}
            <button
              type="button"
              className="button button--small"
              disabled={jump !== "go"}
              title={jumpWhy ?? ja.stash.baseJumpHint}
              onClick={onJumpBase}
            >
              {ja.stash.baseJump}
            </button>
            {jumpWhy !== null && <p className="cdetail__aside">{jumpWhy}</p>}
          </dd>
        </dl>
      </section>

      {files.error !== null && <p className="cinfo__error">{files.error}</p>}

      <FileList
        title={ja.stash.tracked}
        changes={files.tracked}
        selectedPath={files.selected?.section === "tracked" ? files.selected.path : null}
        layout={layout}
        onSelect={(path) => files.select("tracked", path)}
        onLayoutChange={setLayout}
        onFileHistory={onFileHistory}
      />

      {/* **未追跡のファイルを黙って隠さない**（`git stash show` の既定では出ない）。 */}
      {files.untracked.length > 0 && (
        <>
          <p className="stash__note">{ja.stash.untrackedNote}</p>
          <FileList
            title={ja.stash.untracked}
            changes={files.untracked}
            selectedPath={files.selected?.section === "untracked" ? files.selected.path : null}
            layout={layout}
            onSelect={(path) => files.select("untracked", path)}
            onLayoutChange={setLayout}
          />
        </>
      )}
    </div>
  );
}
