/**
 * 右ペイン — 作業ツリーのファイル一覧（docs/DESIGN.md §7.5）。
 *
 * **セクションに分ける。** CLI 派である以上、index と作業ツリーの区別は
 * 当然見たいものとして扱う。衝突があれば**先頭に**出す（直さないと先へ進めない）。
 *
 * **read-only。** stage / unstage / discard / stash を頼むボタンはここに無いし、
 * 作らない（CLAUDE.md §1）。
 */
import { ja } from "../../i18n/ja";
import type { WorkingSection, WorkingTree } from "../../lib/ipc";
import {
  entryKey,
  sectionEntries,
  SECTION_ORDER,
  type WorkingSelection,
} from "../../lib/workingTree";
import { FileRow } from "./FileList";

export function WorkingTreeFiles({
  tree,
  selected,
  onSelect,
  onReload,
}: {
  tree: WorkingTree;
  selected: WorkingSelection | null;
  onSelect: (selection: WorkingSelection) => void;
  onReload: () => void;
}) {
  const key = selected === null ? null : entryKey(selected);

  return (
    <section className="wtree">
      <header className="wtree__head">
        <span className="flist__title">{ja.workingTree.title}</span>
        <div className="app__spacer" />
        <span className="flist__aside" title={ja.diff.keyHint}>
          {ja.diff.keyHint}
        </span>
        <button type="button" className="button button--small" onClick={onReload}>
          {ja.workingTree.reload}
        </button>
      </header>

      {/* **消さない。表示するだけ**（CLAUDE.md §2）。 */}
      {tree.indexLockPresent && <p className="wtree__lock">{ja.workingTree.indexLock}</p>}

      <div className="wtree__body">
        {SECTION_ORDER.map((section) => (
          <Section
            key={section}
            section={section}
            tree={tree}
            selectedKey={key}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

function Section({
  section,
  tree,
  selectedKey,
  onSelect,
}: {
  section: WorkingSection;
  tree: WorkingTree;
  selectedKey: string | null;
  onSelect: (selection: WorkingSelection) => void;
}) {
  const entries = sectionEntries(tree, section);
  // 空のセクションは見出しごと出さない（4 つ並ぶと何も無い行ばかりになる）。
  if (entries.length === 0) return null;

  // バーの尺度はセクションの中で取る。セクションごとに変更の大きさが違うため。
  const scale = Math.max(
    1,
    ...entries.map((entry) => (entry.change?.additions ?? 0) + (entry.change?.deletions ?? 0)),
  );

  return (
    <div className={`wtree__section wtree__section--${section}`}>
      <h3 className="wtree__title">
        {ja.workingTree.sections[section]}
        <span className="flist__count">{ja.diff.fileCount(entries.length)}</span>
      </h3>

      <ul className="flist__rows">
        {entries.map((entry) => (
          <li key={entry.path}>
            {entry.change === null ? (
              // 未追跡と衝突は差分を持たないので、増減バーも出さない。
              <button
                type="button"
                className={`flist__row${
                  selectedKey === entryKey(entry) ? " flist__row--selected" : ""
                }`}
                onClick={() => onSelect({ section, path: entry.path })}
              >
                <span className="flist__pathBox">
                  <span className="flist__path">
                    <span className="flist__name">{entry.path}</span>
                  </span>
                </span>
              </button>
            ) : (
              <FileRow
                change={entry.change}
                depth={0}
                flat
                scale={scale}
                selected={selectedKey === entryKey(entry)}
                onSelect={() => onSelect({ section, path: entry.path })}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
