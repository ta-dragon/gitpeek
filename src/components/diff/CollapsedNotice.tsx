/**
 * 大きすぎる差分の案内（docs/DESIGN.md §7.2）。
 *
 * 既定で折りたたむのは DOM の量だけの話ではない。**開くまでは行の対応付けも
 * 語単位差分もハイライトも走らせない**（`DiffPane` が判断する）。
 */
import { ja } from "../../i18n/ja";
import { formatBytes, type DiffSize } from "../../lib/diffRows";

export function CollapsedNotice({ size, onExpand }: { size: DiffSize; onExpand: () => void }) {
  return (
    <div className="dpane__notice">
      <p className="dpane__error">{ja.diff.collapsedTitle}</p>
      <p className="dpane__detail">{ja.diff.collapsedDetail(size.lines, formatBytes(size.bytes))}</p>
      <button type="button" className="button" onClick={onExpand}>
        {ja.diff.expand}
      </button>
    </div>
  );
}
