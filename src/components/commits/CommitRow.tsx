/**
 * コミットリストの 1 行（docs/DESIGN.md §6.3）。
 *
 * 列は `グラフ | subject + ref チップ | 作者名 | 日時 | 短縮 SHA`。
 * **グラフ列はここでは描かない**（1 枚の SVG をリストの上に重ねている）。
 * ここが持つのはグラフ列ぶんの空きだけ。
 *
 * 行の高さは `graphPath.ts` の `ROW_HEIGHT` と一致していなければならない。
 * ずれるとノードと行がずれる。
 */
import { memo } from "react";

import { ja } from "../../i18n/ja";
import type { ColumnWidths, RefEntry, UiSettings } from "../../lib/ipc";
import { absoluteTimeDetailed, absoluteTime, relativeTime } from "../../lib/relativeTime";
import type { CommitMeta } from "../../lib/ipc";
import { RefChips } from "./RefChips";

type Props = {
  commit: CommitMeta;
  refs: RefEntry[];
  headBranch: string | null;
  detachedHead: boolean;
  selected: boolean;
  /** 2 点比較の**比較元**の行（T-15）。比較先は `selected` のほう。 */
  compareFrom: boolean;
  /** コミット検索で当たった行（T-35）。**文字は塗らず、行の背を変えるだけ。** */
  hit: boolean;
  /** 当たりのうち、いま辿っている 1 件。上から囲む（差分内検索と同じ見せ方）。 */
  hitCurrent: boolean;
  columns: ColumnWidths;
  dateFormat: UiSettings["dateFormat"];
  /** グラフ列の幅。行の左端に空ける。 */
  graphWidth: number;
  onSelect: (sha: string, compare: boolean) => void;
  /** 行の右クリック（T-18）。checkout とコピーを出す。 */
  onContextMenu: (sha: string, x: number, y: number) => void;
  /** ref チップの右クリック（T-18）。**行とは別のメニュー**。 */
  onRefContextMenu: (entry: RefEntry, x: number, y: number) => void;
};

export const CommitRow = memo(function CommitRow({
  commit,
  refs,
  headBranch,
  detachedHead,
  selected,
  compareFrom,
  hit,
  hitCurrent,
  columns,
  dateFormat,
  graphWidth,
  onSelect,
  onContextMenu,
  onRefContextMenu,
}: Props) {
  const absolute = absoluteTimeDetailed(commit.commitTime);

  return (
    <div
      className={`crow${selected ? " crow--selected" : ""}${
        compareFrom ? " crow--compare-from" : ""
      }${hit ? " crow--hit" : ""}${hitCurrent ? " crow--hit-current" : ""}`}
      // **Ctrl（Mac は Cmd）で 2 点比較**（docs/DESIGN.md §10.3）。
      onClick={(event) => onSelect(commit.sha, event.ctrlKey || event.metaKey)}
      // **右クリックでも行を選ぶ。** メニューの対象と選択中の行がずれると、
      // 「どのコミットに対する操作か」が読めなくなる。
      onContextMenu={(event) => {
        event.preventDefault();
        onSelect(commit.sha, false);
        onContextMenu(commit.sha, event.clientX, event.clientY);
      }}
      role="row"
    >
      <div className="crow__graph" style={{ width: graphWidth }} />

      <div className="crow__subject" style={{ width: columns.subject }}>
        <RefChips
          refs={refs}
          headBranch={headBranch}
          detachedHead={detachedHead}
          onContextMenu={onRefContextMenu}
        />
        <span className="crow__text" title={commit.subject}>
          {commit.subject === "" ? ja.commits.emptySubject : commit.subject}
        </span>
      </div>

      {/* 作者は名前のみ。アバターは出さない（外部通信禁止 — CLAUDE.md §1）。 */}
      <div className="crow__author" style={{ width: columns.author }} title={commit.authorEmail}>
        {commit.authorName}
      </div>

      <div className="crow__date" style={{ width: columns.date }} title={absolute}>
        {dateFormat === "relative"
          ? relativeTime(commit.commitTime)
          : absoluteTime(commit.commitTime)}
      </div>

      {/* 短縮 SHA は %h をそのまま使う。フロントで切り詰めない。 */}
      <div className="crow__sha" style={{ width: columns.sha }} title={commit.sha}>
        {commit.shortSha}
      </div>
    </div>
  );
});
