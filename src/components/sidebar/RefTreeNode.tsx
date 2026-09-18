/**
 * ブランチ / タグツリーのノード 1 個（docs/DESIGN.md §6.4）。
 *
 * フォルダは開閉と一括チェック、ref はチェック・ジャンプ・右クリックメニューを持つ。
 * **タグにはチェックボックスを置かない** — 起点 ref ではないので、外してもグラフが
 * 変わらない（docs/DESIGN.md §4.2）。効かないチェックを置くほうが分かりにくい。
 */
import { ja } from "../../i18n/ja";
import type { BranchStatus, RefEntry } from "../../lib/ipc";
import { checkStateOf, isHeadRef, type CheckState, type RefTreeNode } from "../../lib/refTree";
import { ContainmentMark } from "../common/ContainmentMark";

/** 1 段ぶんの字下げ幅（px）。狭いサイドバーで深いパスも読めるよう控えめにする。 */
const INDENT = 12;

export type NodeCallbacks = {
  /** その ID が畳まれているか。 */
  isCollapsed: (id: string) => boolean;
  onToggleCollapse: (id: string) => void;
  /** チェックの一括切り替え。フォルダなら配下すべて。 */
  onToggleVisible: (names: string[], show: boolean) => void;
  onJump: (entry: RefEntry) => void;
  /** 取り込まれているかの印のクリック（T-38）。squash コミットへ飛ぶ。 */
  onJumpSquash: (sha: string) => void;
  onContextMenu: (entry: RefEntry, x: number, y: number) => void;
  /** ダブルクリック。**checkout の確認を出す**（T-18。docs/DESIGN.md §8.1）。 */
  onActivate: (entry: RefEntry) => void;
};

export function RefTreeNodeView({
  node,
  depth,
  checkable,
  excluded,
  statusByRef,
  headBranch,
  callbacks,
}: {
  node: RefTreeNode;
  depth: number;
  /** チェックボックスを出すか。タググループでは false。 */
  checkable: boolean;
  excluded: Set<string>;
  statusByRef: Map<string, BranchStatus>;
  /** HEAD が乗っているローカルブランチの完全名。detached なら null。 */
  headBranch: string | null;
  callbacks: NodeCallbacks;
}) {
  if (node.kind === "folder") {
    const collapsed = callbacks.isCollapsed(node.id);
    const state = checkStateOf(excluded, node.refNames);

    return (
      <li className="reftree__item">
        <div className="reftree__row" style={{ paddingLeft: depth * INDENT }}>
          {/* 三角は CSS で描く（文字だと小さすぎて開閉が読めない）。 */}
          <button
            type="button"
            className={`reftree__caret${collapsed ? "" : " reftree__caret--open"}`}
            aria-expanded={!collapsed}
            aria-label={collapsed ? ja.refTree.expand : ja.refTree.collapse}
            onClick={() => callbacks.onToggleCollapse(node.id)}
          />
          {checkable && (
            <Check
              state={state}
              onChange={(show) => callbacks.onToggleVisible(node.refNames, show)}
            />
          )}
          <span className="reftree__folder">{node.label}</span>
          <span className="reftree__count">{ja.refTree.groupCount(node.refNames.length)}</span>
        </div>

        {!collapsed && (
          <ul className="reftree__children">
            {node.children.map((child) => (
              <RefTreeNodeView
                key={child.id}
                node={child}
                depth={depth + 1}
                checkable={checkable}
                excluded={excluded}
                statusByRef={statusByRef}
                headBranch={headBranch}
                callbacks={callbacks}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const entry = node.entry;
  const status = statusByRef.get(entry.name);
  const isHead = isHeadRef(entry, headBranch);
  // グラフから外している ref は淡くする。チェックの有無は小さくて遠目に分からない。
  const hidden = checkable && excluded.has(entry.name);

  return (
    <li className="reftree__item">
      <div
        className={`reftree__row${isHead ? " reftree__row--head" : ""}`}
        style={{ paddingLeft: depth * INDENT }}
        onContextMenu={(event) => {
          event.preventDefault();
          callbacks.onContextMenu(entry, event.clientX, event.clientY);
        }}
        // **ダブルクリックで checkout。** 1 クリックはジャンプなので、
        // ここで確認を出さないと「見に行くつもりが切り替わる」ことになる。
        onDoubleClick={() => callbacks.onActivate(entry)}
      >
        {/* フォルダの三角と桁を揃えるための空き。 */}
        <span className="reftree__caret reftree__caret--leaf" aria-hidden="true" />
        {checkable ? (
          <Check
            state={excluded.has(entry.name) ? "off" : "on"}
            title={ja.refTree.checkHint(entry.shortName)}
            onChange={(show) => callbacks.onToggleVisible([entry.name], show)}
          />
        ) : (
          <span className="reftree__check reftree__check--none" aria-hidden="true" />
        )}

        <button
          type="button"
          className={
            "reftree__name" +
            (entry.orphan ? " reftree__name--orphan" : "") +
            (hidden ? " reftree__name--hidden" : "")
          }
          disabled={entry.outOfGraph}
          title={titleOf(entry, status, isHead)}
          onClick={() => callbacks.onJump(entry)}
        >
          {entry.orphan && <span className="chip__mark">{ja.commits.orphanMark}</span>}
          {node.label}
        </button>

        {entry.outOfGraph && (
          <span className="reftree__badge" title={ja.refTree.outOfGraphHint}>
            {ja.refTree.outOfGraph}
          </span>
        )}
        {status !== undefined && status.ahead > 0 && (
          <span className="reftree__ahead">{ja.refTree.ahead(status.ahead)}</span>
        )}
        {status !== undefined && status.behind > 0 && (
          <span className="reftree__behind">{ja.refTree.behind(status.behind)}</span>
        )}
        {/* 取り込まれているか（T-38）。タグには付かない（調べる対象にしない）。 */}
        {entry.kind !== "tag" && (
          <ContainmentMark entry={entry} variant="tree" onJumpSquash={callbacks.onJumpSquash} />
        )}
      </div>
    </li>
  );
}

/** 三状態のチェックボックス。`partial` は DOM プロパティでしか立てられない。 */
function Check({
  state,
  title,
  onChange,
}: {
  state: CheckState;
  title?: string;
  onChange: (show: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      className="reftree__check"
      checked={state === "on"}
      title={title}
      ref={(element) => {
        if (element !== null) element.indeterminate = state === "partial";
      }}
      // 中途半端な状態から押したときは「全部表示」にする。片方ずつ消すより意図に近い。
      onChange={() => onChange(state !== "on")}
    />
  );
}

function titleOf(entry: RefEntry, status: BranchStatus | undefined, isHead: boolean): string {
  const lines = [entry.name];
  if (isHead) lines.push(ja.refTree.headHint);
  if (entry.orphan) lines.push(ja.commits.orphanHint);
  if (entry.outOfGraph) lines.push(ja.refTree.outOfGraphHint);
  if (status !== undefined) {
    lines.push(
      status.ahead === 0 && status.behind === 0
        ? ja.refTree.upstreamSynced(shortenRef(status.upstream))
        : ja.refTree.upstreamDiff(shortenRef(status.upstream), status.ahead, status.behind),
    );
  }
  return lines.join("\n");
}

/** `refs/remotes/origin/main` → `origin/main`。ツールチップの中だけで使う。 */
function shortenRef(name: string): string {
  return name.replace(/^refs\/(remotes|heads|tags)\//, "");
}
