/**
 * ブランチ一覧の一番下の「stash」の欄（T-42。docs/DESIGN.md §7.5.1）。
 *
 * **見るだけ。** 押すと右の列と差分ペインに中身が出る。作る・戻す・消す項目はどこにも無い
 * （CLAUDE.md §1）。**チェックボックスは置かない**（起点 ref ではない — タグと同じ。CLAUDE.md §6）。
 *
 * **stash が無くても欄は出し、無いと書く**（欄ごと消すと、読めなかったのか無いのか区別が付かない）。
 * 既定は開いている（畳むと、忘れている stash に気付けない）。畳んだかどうかはブランチ一覧の
 * 開閉と同じく `collapsedTreeNodes` に残る。
 */
import { ja } from "../../i18n/ja";
import { absoluteTimeDetailed, relativeTime } from "../../lib/relativeTime";
import { stashTitle } from "../../lib/stash";
import { selectStash, useStash } from "../../store/stash";

/** 開閉を覚えるときの ID（`collapsedTreeNodes`）。グループの ID と衝突しない名前にする。 */
export const STASH_NODE_ID = "stash";

export function StashList({
  repositoryId,
  collapsed,
  onToggleCollapse,
}: {
  repositoryId: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const stash = useStash();
  const mine = stash.repositoryId === repositoryId;
  const entries = mine ? stash.entries : null;

  return (
    <li className="reftree__group">
      <div className="reftree__row reftree__row--group" title={ja.stash.titleHint}>
        <button
          type="button"
          className={`reftree__caret${collapsed ? "" : " reftree__caret--open"}`}
          aria-expanded={!collapsed}
          aria-label={collapsed ? ja.refTree.expand : ja.refTree.collapse}
          onClick={onToggleCollapse}
        />
        {/* チェックボックスの桁を揃えるための空き（タグと同じ）。 */}
        <span className="reftree__check reftree__check--none" aria-hidden="true" />
        <span className="reftree__groupName">{ja.stash.title}</span>
        {entries !== null && (
          <span className="reftree__count">{ja.stash.count(entries.length)}</span>
        )}
      </div>

      {!collapsed && (
        <ul className="reftree__children">
          {mine && stash.error !== null ? (
            <li className="reftree__note">{ja.stash.failed(stash.error)}</li>
          ) : entries === null ? (
            <li className="reftree__note">{ja.stash.loading}</li>
          ) : entries.length === 0 ? (
            <li className="reftree__note">{ja.stash.empty}</li>
          ) : (
            entries.map((entry) => {
              const title = stashTitle(entry.message);
              const selected = stash.selected === entry.sha;
              return (
                <li key={entry.sha} className="reftree__item">
                  <div
                    className={`reftree__row stash__row${selected ? " stash__row--selected" : ""}`}
                  >
                    <span className="reftree__caret reftree__caret--leaf" aria-hidden="true" />
                    <span className="reftree__check reftree__check--none" aria-hidden="true" />
                    <button
                      type="button"
                      className="reftree__name stash__name"
                      aria-pressed={selected}
                      title={ja.stash.rowHint(
                        entry.label,
                        title.branch,
                        absoluteTimeDetailed(entry.time),
                      )}
                      onClick={() => selectStash(entry.sha)}
                    >
                      <span className="stash__label">{entry.label}</span>
                      {title.unnamed && (
                        <span className="stash__unnamed" title={ja.stash.unnamedHint}>
                          {ja.stash.unnamed}
                        </span>
                      )}
                      <span className="stash__text">{title.text}</span>
                    </button>
                    <span className="stash__time">{relativeTime(entry.time)}</span>
                  </div>
                </li>
              );
            })
          )}
        </ul>
      )}
    </li>
  );
}
