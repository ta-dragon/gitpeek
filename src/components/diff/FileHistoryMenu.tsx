/**
 * 変更ファイルの右クリック（T-40。docs/DESIGN.md §6.7）。
 *
 * 項目は「このファイルを変えたコミットに印を付ける」の 1 つだけ。押せるかどうかと、
 * 検索欄に入れる文字は `lib/fileHistory.ts` の `fileHistoryAction` が決める。
 * **押せないときも消さない**（CLAUDE.md §6）。
 */
import { ContextMenu } from "../common/ContextMenu";
import { ja } from "../../i18n/ja";
import { fileHistoryAction } from "../../lib/fileHistory";

/** 右クリックされた位置とファイル。 */
export type FileMenuAt = { x: number; y: number; path: string; untracked: boolean };

export function FileHistoryMenu({
  at,
  onClose,
  onFileHistory,
}: {
  at: FileMenuAt;
  onClose: () => void;
  /** 検索欄にこの文字を入れて探す。 */
  onFileHistory: (input: string) => void;
}) {
  const action = fileHistoryAction(at.path, at.untracked);
  return (
    <ContextMenu
      x={at.x}
      y={at.y}
      onClose={onClose}
      items={[
        {
          label: ja.diff.fileHistory,
          disabled: action.kind !== "ready",
          title:
            action.kind === "untracked"
              ? ja.diff.fileHistoryUntracked
              : action.kind === "unquotable"
                ? ja.diff.fileHistoryUnquotable
                : undefined,
          onSelect: () => {
            if (action.kind === "ready") onFileHistory(action.input);
          },
        },
      ]}
    />
  );
}
