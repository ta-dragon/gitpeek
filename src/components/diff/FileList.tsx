/**
 * 右ペインの下段 — 変更ファイル一覧（docs/DESIGN.md §7.3）。
 *
 * 既定は**フラットなパス一覧**（共通ディレクトリを淡色にしてファイル名を強調）で、
 * ディレクトリツリーに切り替えられる。ファイルごとに `+N` `-M` と増減バーを出す。
 *
 * **全ファイルを縦に連結してスクロールする方式は採らない**（§7.3）。一覧で 1 つ選び、
 * 中央下の差分ペインにその差分だけを出す。
 */
import { useMemo } from "react";

import { ja } from "../../i18n/ja";
import {
  buildFileTree,
  splitPath,
  totalChanges,
  type FileTreeNode,
} from "../../lib/fileTree";
import { isBinaryChange, type ChangeStatus, type FileChange } from "../../lib/ipc";

/** 一覧の表示形式。既定はフラット（docs/DESIGN.md §7.3）。 */
export type FileListLayout = "flat" | "tree";

/** 増減バーの最大幅（px）。長い差分でも横に伸び続けないように上限を切る。 */
const BAR_WIDTH = 48;

/** 1 段ぶんの字下げ幅（px）。 */
const INDENT = 12;

type Props = {
  changes: FileChange[];
  selectedPath: string | null;
  layout: FileListLayout;
  onSelect: (path: string) => void;
  onLayoutChange: (layout: FileListLayout) => void;
};

export function FileList({
  changes,
  selectedPath,
  layout,
  onSelect,
  onLayoutChange,
}: Props) {
  const total = useMemo(() => totalChanges(changes), [changes]);
  const tree = useMemo(
    () => (layout === "tree" ? buildFileTree(changes) : []),
    [changes, layout],
  );

  // バーの尺度は「そのコミットで最も大きく変わったファイル」に合わせる。
  // 固定値にすると、小さいコミットでは全部が同じ長さになって差が見えない。
  const scale = useMemo(() => {
    let max = 1;
    for (const change of changes) {
      const sum = (change.additions ?? 0) + (change.deletions ?? 0);
      if (sum > max) max = sum;
    }
    return max;
  }, [changes]);

  return (
    <section className="flist">
      <header className="flist__head">
        <span className="flist__title">{ja.diff.files}</span>
        <span className="flist__count">{ja.diff.fileCount(total.files)}</span>
        {total.additions > 0 && (
          <span className="flist__add">{ja.diff.additions(total.additions)}</span>
        )}
        {total.deletions > 0 && (
          <span className="flist__del">{ja.diff.deletions(total.deletions)}</span>
        )}
        {total.binaries > 0 && (
          <span className="flist__aside">{ja.diff.binaryCount(total.binaries)}</span>
        )}

        <div className="app__spacer" />

        <span className="flist__aside" title={ja.diff.keyHint}>
          {ja.diff.keyHint}
        </span>
        <label className="flist__layout">
          {ja.diff.layoutLabel}
          <select
            className="select select--small"
            value={layout}
            onChange={(event) => onLayoutChange(event.target.value as FileListLayout)}
          >
            <option value="flat">{ja.diff.layoutFlat}</option>
            <option value="tree">{ja.diff.layoutTree}</option>
          </select>
        </label>
      </header>

      <div className="flist__body">
        {changes.length === 0 ? (
          <p className="flist__empty">{ja.diff.noFiles}</p>
        ) : layout === "flat" ? (
          <ul className="flist__rows">
            {changes.map((change) => (
              <li key={change.path}>
                <Row
                  change={change}
                  depth={0}
                  flat
                  scale={scale}
                  selected={change.path === selectedPath}
                  onSelect={onSelect}
                />
              </li>
            ))}
          </ul>
        ) : (
          <ul className="flist__rows">
            {tree.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                depth={0}
                scale={scale}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function TreeNode({
  node,
  depth,
  scale,
  selectedPath,
  onSelect,
}: {
  node: FileTreeNode;
  depth: number;
  scale: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  if (node.kind === "file") {
    return (
      <li>
        <Row
          change={node.change}
          depth={depth}
          flat={false}
          scale={scale}
          selected={node.change.path === selectedPath}
          onSelect={onSelect}
        />
      </li>
    );
  }

  // ディレクトリは開閉しない。**1 コミットの変更ファイルは高々数十件**で、
  // 畳む価値より「全部見えている」ほうが速い（ref ツリーとはそこが違う）。
  return (
    <li>
      <div className="flist__dir" style={{ paddingLeft: 8 + depth * INDENT }}>
        <span className="flist__dirName">{node.label}/</span>
        <span className="flist__aside">{ja.diff.fileCount(node.fileCount)}</span>
      </div>
      <ul className="flist__rows">
        {node.children.map((child) => (
          <TreeNode
            key={child.id}
            node={child}
            depth={depth + 1}
            scale={scale}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </li>
  );
}

function Row({
  change,
  depth,
  flat,
  scale,
  selected,
  onSelect,
}: {
  change: FileChange;
  depth: number;
  /** フラット表示ではディレクトリを淡色で前置する。 */
  flat: boolean;
  scale: number;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  const { dir, name } = splitPath(change.path);
  const binary = isBinaryChange(change);
  const additions = change.additions ?? 0;
  const deletions = change.deletions ?? 0;

  return (
    <button
      type="button"
      className={`flist__row${selected ? " flist__row--selected" : ""}`}
      style={{ paddingLeft: 8 + depth * INDENT }}
      title={titleOf(change)}
      onClick={() => onSelect(change.path)}
    >
      <span className={`flist__status flist__status--${change.status}`}>
        {statusMark(change.status)}
      </span>

      {/*
       * リネーム元は**行内に並べず 2 行目に置く**。右ペインは幅が 380px 程度しかなく、
       * 横に並べるとパスと増減が押し合って両方読めなくなる。
       */}
      <span className="flist__pathBox">
        <span className="flist__path">
          {flat && dir !== "" && <span className="flist__dirPart">{dir}</span>}
          <span className="flist__name">{name}</span>
        </span>
        {change.oldPath !== null && (
          <span className="flist__rename">{ja.diff.renamedFrom(change.oldPath)}</span>
        )}
      </span>

      <div className="app__spacer" />

      {binary ? (
        <span className="flist__aside">{ja.diff.binary}</span>
      ) : (
        <>
          {additions > 0 && <span className="flist__add">{ja.diff.additions(additions)}</span>}
          {deletions > 0 && <span className="flist__del">{ja.diff.deletions(deletions)}</span>}
          <Bar additions={additions} deletions={deletions} scale={scale} />
        </>
      )}
    </button>
  );
}

/** 増減の横バー。幅はそのコミット内で最大のファイルを 100% とした割合。 */
function Bar({
  additions,
  deletions,
  scale,
}: {
  additions: number;
  deletions: number;
  scale: number;
}) {
  const total = additions + deletions;
  if (total === 0) return <span className="flist__bar" />;

  const width = Math.max(1, Math.round((total / scale) * BAR_WIDTH));
  const addWidth = Math.round((additions / total) * width);

  return (
    <span className="flist__bar" style={{ width }}>
      <span className="flist__barAdd" style={{ width: addWidth }} />
      <span className="flist__barDel" style={{ width: width - addWidth }} />
    </span>
  );
}

function statusMark(status: ChangeStatus): string {
  switch (status) {
    case "added":
      return ja.diff.statusAdded;
    case "modified":
      return ja.diff.statusModified;
    case "deleted":
      return ja.diff.statusDeleted;
    case "renamed":
      return ja.diff.statusRenamed;
    case "copied":
      return ja.diff.statusCopied;
    case "typeChanged":
      return ja.diff.statusTypeChanged;
    case "unknown":
      return ja.diff.statusUnknown;
  }
}

function titleOf(change: FileChange): string {
  const lines = [change.path, ja.diff.statusName[change.status]];
  if (change.oldPath !== null) lines.push(ja.diff.renamedFrom(change.oldPath));
  // モード変更は差分ヘッダで明示するのが本筋（T-13）だが、一覧でも気付けるようにしておく。
  if (
    change.oldMode !== change.newMode &&
    change.oldMode !== "000000" &&
    change.newMode !== "000000"
  ) {
    lines.push(ja.diff.modeChanged(change.oldMode, change.newMode));
  }
  if (isBinaryChange(change)) lines.push(ja.diff.binary);
  return lines.join("\n");
}
