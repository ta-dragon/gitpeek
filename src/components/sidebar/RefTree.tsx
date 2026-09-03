/**
 * ブランチ / タグツリー（docs/DESIGN.md §6.4）。
 *
 * チェックを外すと**到達可能集合を計算し直して行と線が実際に減る**（§4.4）。
 * 淡色化ではない。切り替えのたびに `compute_lane_layout` を呼び直すが、
 * `git log` は走らない（Rust 側のメモリ上のグラフを引き直すだけ）。
 */
import { useMemo, useState } from "react";

import { ja } from "../../i18n/ja";
import type { BranchStatus, HeadInfo, RefEntry, VisibleRefs } from "../../lib/ipc";
import {
  branchNames,
  buildRefTree,
  checkStateOf,
  excludedSet,
  onlyVisible,
  withVisibility,
  type RefGroup,
} from "../../lib/refTree";
import { ContextMenu, type ContextMenuItem } from "../common/ContextMenu";
import { RefTreeNodeView, type NodeCallbacks } from "./RefTreeNode";

type Props = {
  refs: RefEntry[];
  head: HeadInfo;
  /** 上流を持つローカルブランチだけが入る（docs/DESIGN.md §4.5）。 */
  branchStatus: BranchStatus[];
  visibleRefs: VisibleRefs;
  /** 畳んでいるノードの ID。**既定は展開**なので、空なら全部開いている。 */
  collapsed: string[];
  onVisibleRefsChange: (next: VisibleRefs) => void;
  onCollapsedChange: (next: string[]) => void;
  /** そのコミットを選んでリストをスクロールさせる。 */
  onJump: (sha: string) => void;
  /** コピーの結果など、短い通知を出す。 */
  onNotice: (message: string) => void;
};

export function RefTree({
  refs,
  head,
  branchStatus,
  visibleRefs,
  collapsed,
  onVisibleRefsChange,
  onCollapsedChange,
  onJump,
  onNotice,
}: Props) {
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<{ entry: RefEntry; x: number; y: number } | null>(null);

  const groups = useMemo(() => buildRefTree(refs, filter), [refs, filter]);
  const excluded = useMemo(() => excludedSet(visibleRefs), [visibleRefs]);
  const collapsedSet = useMemo(() => new Set(collapsed), [collapsed]);
  const statusByRef = useMemo(() => {
    const map = new Map<string, BranchStatus>();
    for (const status of branchStatus) map.set(status.refName, status);
    return map;
  }, [branchStatus]);

  const callbacks: NodeCallbacks = {
    isCollapsed: (id) => collapsedSet.has(id),
    onToggleCollapse: (id) => {
      const next = new Set(collapsedSet);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onCollapsedChange([...next]);
    },
    onToggleVisible: (names, show) =>
      onVisibleRefsChange(withVisibility(visibleRefs, names, show)),
    onJump: (entry) => {
      if (!entry.outOfGraph) onJump(entry.target);
    },
    onContextMenu: (entry, x, y) => setMenu({ entry, x, y }),
  };

  /** プリセット。**タグは `excluded` に入れない**（起点 ref ではない）。 */
  const preset = (keep: "all" | "none" | "localBranch" | "remoteBranch") => {
    if (keep === "all") {
      onVisibleRefsChange({ mode: "all", excluded: [] });
      return;
    }
    const all = branchNames(refs);
    onVisibleRefsChange(onlyVisible(all, keep === "none" ? [] : branchNames(refs, keep)));
  };

  return (
    <section className="reftree">
      <header className="reftree__header">
        <span className="reftree__title">{ja.refTree.title}</span>
        <div className="app__spacer" />
        <span className="reftree__count">{refs.length}</span>
      </header>

      <div className="reftree__filter">
        <input
          className="input"
          value={filter}
          placeholder={ja.refTree.filterPlaceholder}
          onChange={(event) => setFilter(event.target.value)}
        />
        {filter !== "" && (
          <button
            type="button"
            className="button button--small"
            title={ja.refTree.filterClear}
            onClick={() => setFilter("")}
          >
            ×
          </button>
        )}
      </div>

      <div className="reftree__presets" title={ja.refTree.presetHint}>
        <button type="button" className="button button--small" onClick={() => preset("all")}>
          {ja.refTree.presetAll}
        </button>
        <button type="button" className="button button--small" onClick={() => preset("none")}>
          {ja.refTree.presetNone}
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={() => preset("localBranch")}
        >
          {ja.refTree.presetLocal}
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={() => preset("remoteBranch")}
        >
          {ja.refTree.presetRemote}
        </button>
      </div>

      <div className="reftree__body">
        {groups.length === 0 ? (
          <p className="reftree__empty">
            {refs.length === 0 ? ja.refTree.empty : ja.refTree.filterEmpty}
          </p>
        ) : (
          <ul className="reftree__groups">
            {groups.map((group) => (
              <Group
                key={group.id}
                group={group}
                excluded={excluded}
                statusByRef={statusByRef}
                headBranch={head.branch}
                callbacks={callbacks}
              />
            ))}
          </ul>
        )}
      </div>

      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={menuItems(menu.entry, refs, {
            onJump,
            onNotice,
            onVisibleRefsChange,
          })}
        />
      )}
    </section>
  );
}

function Group({
  group,
  excluded,
  statusByRef,
  headBranch,
  callbacks,
}: {
  group: RefGroup;
  excluded: Set<string>;
  statusByRef: Map<string, BranchStatus>;
  headBranch: string | null;
  callbacks: NodeCallbacks;
}) {
  const collapsed = callbacks.isCollapsed(group.id);
  // タグは起点 ref ではないので、チェックの対象にしない（docs/DESIGN.md §4.2）。
  const checkable = group.kind !== "tag";
  const state = checkStateOf(excluded, group.refNames);

  return (
    <li className="reftree__group">
      <div className="reftree__row reftree__row--group">
        <button
          type="button"
          className="reftree__caret"
          aria-expanded={!collapsed}
          onClick={() => callbacks.onToggleCollapse(group.id)}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        {checkable && (
          <input
            type="checkbox"
            className="reftree__check"
            checked={state === "on"}
            ref={(element) => {
              if (element !== null) element.indeterminate = state === "partial";
            }}
            onChange={() => callbacks.onToggleVisible(group.refNames, state !== "on")}
          />
        )}
        <span className="reftree__groupName">{groupLabel(group)}</span>
        <span className="reftree__count">{ja.refTree.groupCount(group.refNames.length)}</span>
      </div>

      {!collapsed && (
        <ul className="reftree__children">
          {group.children.map((node) => (
            <RefTreeNodeView
              key={node.id}
              node={node}
              depth={1}
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

function groupLabel(group: RefGroup): string {
  switch (group.kind) {
    case "local":
      return ja.refTree.groupLocal;
    case "remote":
      return ja.refTree.groupRemote(group.remote ?? "");
    case "tag":
      return ja.refTree.groupTag;
  }
}

/**
 * 右クリックメニュー（docs/DESIGN.md §6.4）。
 *
 * checkout と FF マージは**項目としては出すが無効**にする。T-18 で中身が入るまで、
 * 「この機能はここにある」ことだけ示しておく。
 */
function menuItems(
  entry: RefEntry,
  refs: RefEntry[],
  actions: {
    onJump: (sha: string) => void;
    onNotice: (message: string) => void;
    onVisibleRefsChange: (next: VisibleRefs) => void;
  },
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { label: ja.refTree.checkout, title: ja.refTree.notYet, disabled: true, onSelect: () => {} },
  ];

  if (entry.kind !== "tag") {
    items.push({
      label: ja.refTree.merge,
      title: ja.refTree.notYet,
      disabled: true,
      onSelect: () => {},
    });
    items.push({
      label: ja.refTree.onlyThis,
      onSelect: () => actions.onVisibleRefsChange(onlyVisible(branchNames(refs), [entry.name])),
    });
  }

  items.push({
    label: ja.refTree.jump,
    disabled: entry.outOfGraph,
    title: entry.outOfGraph ? ja.refTree.outOfGraphHint : undefined,
    onSelect: () => actions.onJump(entry.target),
  });
  items.push({
    label: ja.refTree.copyName,
    onSelect: () => void copyText(entry.shortName, actions.onNotice),
  });
  items.push({
    label: ja.refTree.copySha,
    onSelect: () => void copyText(entry.target, actions.onNotice),
  });

  return items;
}

/**
 * クリップボードへ書く。
 *
 * Tauri のクリップボードプラグインは入れない。WebView2 の中は secure context
 * なので `navigator.clipboard` がそのまま使え、権限を 1 つ増やさずに済む。
 * 失敗したときは黙らず通知する（コピーできたと思わせないため）。
 */
async function copyText(text: string, onNotice: (message: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    onNotice(ja.refTree.copied(text));
  } catch {
    onNotice(ja.refTree.copyFailed);
  }
}
