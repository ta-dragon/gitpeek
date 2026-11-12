/**
 * 畳んだペインの帯（T-47。docs/DESIGN.md §6.1.1）。**どこを押しても開く。**
 *
 * 完全に消すと、畳んだのか、そもそも無いのかが見分けられない（CLAUDE.md §6「覚えている状態は
 * 必ず画面に出す」）。ツールチップの文言とキーは純関数（`lib/panes.ts`）。
 */
import { ja } from "../../i18n/ja";
import { paneHint, type CollapsiblePane } from "../../lib/panes";

export function CollapsedBar({
  pane,
  orientation,
  detail = null,
  onExpand,
}: {
  pane: CollapsiblePane;
  /** 左右は縦の細い列、中央下は横の細い行。 */
  orientation: "vertical" | "horizontal";
  /** 名前の横に添える一行（差分の帯の「選んでいるファイル」）。 */
  detail?: string | null;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      className={`pane-bar pane-bar--${orientation}`}
      title={paneHint(pane, true)}
      onClick={onExpand}
    >
      <span className="pane-bar__name">{ja.panes[pane]}</span>
      {detail !== null && <span className="pane-bar__detail">{detail}</span>}
    </button>
  );
}

/** ペインの見出しに置く「畳む」ボタン。 */
export function CollapseButton({
  pane,
  onCollapse,
}: {
  pane: CollapsiblePane;
  onCollapse: () => void;
}) {
  return (
    <button
      type="button"
      className="button button--small"
      title={paneHint(pane, false)}
      onClick={onCollapse}
    >
      {ja.panes.collapse}
    </button>
  );
}
