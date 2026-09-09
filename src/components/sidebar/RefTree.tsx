/**
 * ブランチ / タグツリー（docs/DESIGN.md §6.4）。
 *
 * 更新日で選び直すのと CSV への書き出しも同じ §6.4。**どちらも git を呼ばない。**
 *
 * チェックを外すと**到達可能集合を計算し直して行と線が実際に減る**（§4.4）。
 * 淡色化ではない。切り替えのたびに `compute_lane_layout` を呼び直すが、
 * `git log` は走らない（Rust 側のメモリ上のグラフを引き直すだけ）。
 */
import { save } from "@tauri-apps/plugin-dialog";
import { useMemo, useState } from "react";

import { ja } from "../../i18n/ja";
import { branchCsvRows, csvExportState, csvFileName, toCsv } from "../../lib/branchCsv";
import { exportText } from "../../lib/ipc";
import type { BranchStatus, CommitMeta, HeadInfo, RefEntry, VisibleRefs } from "../../lib/ipc";
import {
  branchNames,
  branchesUpdatedSince,
  buildRefTree,
  checkStateOf,
  commitTimes,
  excludedSet,
  onlyVisible,
  startOfDay,
  withVisibility,
  type RefGroup,
} from "../../lib/refTree";
import { ContextMenu, type ContextMenuItem } from "../common/ContextMenu";
import { fetchMergeItem } from "../common/refMenu";
import { RefTreeNodeView, type NodeCallbacks } from "./RefTreeNode";

type Props = {
  refs: RefEntry[];
  head: HeadInfo;
  /**
   * 全件揃っているコミット（CLAUDE.md §3.4）。
   *
   * **ブランチの最終コミット時刻はここから引く。** git を呼び直さないので、
   * 日付で選ぶのも CSV に書くのも、追加のコマンドは 1 つも走らない。
   */
  commits: CommitMeta[];
  /** CSV の既定ファイル名に使う登録名。 */
  repositoryName: string;
  /** 上流を持つローカルブランチだけが入る（docs/DESIGN.md §4.5）。 */
  branchStatus: BranchStatus[];
  visibleRefs: VisibleRefs;
  /** 畳んでいるノードの ID。**既定は展開**なので、空なら全部開いている。 */
  collapsed: string[];
  onVisibleRefsChange: (next: VisibleRefs) => void;
  onCollapsedChange: (next: string[]) => void;
  /** そのコミットを選んでリストをスクロールさせる。 */
  onJump: (sha: string) => void;
  /** checkout の確認を出す（T-18。docs/DESIGN.md §8.1）。 */
  onCheckout: (entry: RefEntry) => void;
  /** 現在のブランチへ FF マージする確認を出す（T-18。docs/DESIGN.md §8.2）。 */
  onMerge: (entry: RefEntry) => void;
  /** 取ってきてから取り込む確認を出す（T-31。docs/DESIGN.md §8.6）。 */
  onFetchMerge: (entry: RefEntry) => void;
  /** コピーの結果など、短い通知を出す。 */
  onNotice: (message: string) => void;
};

export function RefTree({
  refs,
  head,
  commits,
  repositoryName,
  branchStatus,
  visibleRefs,
  collapsed,
  onVisibleRefsChange,
  onCollapsedChange,
  onJump,
  onCheckout,
  onMerge,
  onFetchMerge,
  onNotice,
}: Props) {
  const [filter, setFilter] = useState("");
  const [since, setSince] = useState("");
  const [menu, setMenu] = useState<{ entry: RefEntry; x: number; y: number } | null>(null);

  const groups = useMemo(() => buildRefTree(refs, filter), [refs, filter]);
  const excluded = useMemo(() => excludedSet(visibleRefs), [visibleRefs]);
  const times = useMemo(() => commitTimes(commits), [commits]);
  // **判定は純関数へ出す**（CLAUDE.md §6, §8）。ここは受け取った結果を描くだけ。
  const sinceAt = useMemo(() => startOfDay(since), [since]);
  const csvRows = useMemo(
    () => branchCsvRows(refs, excluded, times),
    [refs, excluded, times],
  );
  const csvState = csvExportState(csvRows);
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
    // **ダブルクリックで checkout**（docs/DESIGN.md §8.1）。確認は必ず出る。
    onActivate: onCheckout,
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

  /**
   * 更新日でチェックを付け直す（T-33）。**プリセットと同じ一度きりの操作。**
   *
   * 結果は件数で知らせる。0 件のときに「壊れた」ではなく
   * 「その日以降に動いたブランチが無い」と読めるようにするため。
   */
  const applySince = () => {
    if (sinceAt === null) return;
    const keep = branchesUpdatedSince(refs, sinceAt, times);
    onVisibleRefsChange(onlyVisible(branchNames(refs), keep));
    onNotice(ja.refTree.sinceApplied(keep.length));
  };

  /** チェックの入ったブランチを CSV に保存する（T-32）。 */
  const saveCsv = async () => {
    if (csvState.kind === "empty") return;
    const path = await save({
      title: ja.refTree.csv.saveTitle,
      defaultPath: csvFileName(repositoryName, new Date()),
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (path === null) return;
    await exportText(path, toCsv(csvRows));
    onNotice(ja.refTree.csv.saved(path));
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

      <div className="reftree__since">
        <input
          type="date"
          className="input"
          value={since}
          aria-label={ja.refTree.sinceLabel}
          onChange={(event) => setSince(event.target.value)}
        />
        <button
          type="button"
          className="button button--small"
          // **押せないときも消さず、理由を出す**（CLAUDE.md §6）。
          title={sinceAt === null ? ja.refTree.sinceNoDate : ja.refTree.sinceHint}
          disabled={sinceAt === null}
          onClick={applySince}
        >
          {ja.refTree.sinceApply}
        </button>
        <div className="app__spacer" />
        <button
          type="button"
          className="button button--small"
          title={
            csvState.kind === "ready"
              ? ja.refTree.csv.saveHint(csvState.count)
              : ja.refTree.csv.saveEmpty
          }
          disabled={csvState.kind === "empty"}
          onClick={() => void saveCsv()}
        >
          {ja.refTree.csv.save}
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
          items={menuItems(menu.entry, refs, head.branch, {
            onJump,
            onNotice,
            onVisibleRefsChange,
            onCheckout,
            onMerge,
            onFetchMerge,
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
  /** HEAD が乗っているローカルブランチの**短い名前**（`HeadInfo.branch`）。 */
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
          className={`reftree__caret${collapsed ? "" : " reftree__caret--open"}`}
          aria-expanded={!collapsed}
          aria-label={collapsed ? ja.refTree.expand : ja.refTree.collapse}
          onClick={() => callbacks.onToggleCollapse(group.id)}
        />
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
 * **checkout も FF マージも、押すと必ず確認が出る**（T-18）。ここでは可否を判定しない —
 * 判定は Rust 側の 1 箇所だけで、押せない理由は確認画面に出す（docs/DESIGN.md §8.1）。
 * メニューの側で条件を組み直すと、ダブルクリックやグラフ行の経路と結論が食い違う。
 */
function menuItems(
  entry: RefEntry,
  refs: RefEntry[],
  /** HEAD が乗っているローカルブランチの短い名前。detached なら null。 */
  headBranch: string | null,
  actions: {
    onJump: (sha: string) => void;
    onNotice: (message: string) => void;
    onVisibleRefsChange: (next: VisibleRefs) => void;
    onCheckout: (entry: RefEntry) => void;
    onMerge: (entry: RefEntry) => void;
    onFetchMerge: (entry: RefEntry) => void;
  },
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { label: ja.refTree.checkout, onSelect: () => actions.onCheckout(entry) },
  ];

  if (entry.kind !== "tag") {
    items.push({
      // **どちらへ取り込むのかを名前で出す。** 「現在のブランチに」だけでは
      // 何が何に入るのか読めない。detached のときは先が無いので言い切らない。
      label:
        headBranch === null
          ? ja.refTree.merge
          : ja.refTree.mergeInto(headBranch, entry.shortName),
      title: ja.refTree.mergeHint,
      onSelect: () => actions.onMerge(entry),
    });
    // 取ってきてから取り込む（T-31）。**押せなくても消さない**（CLAUDE.md §6）。
    items.push(fetchMergeItem(entry, headBranch, actions.onFetchMerge));
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
