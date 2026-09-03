/**
 * 中央下の差分ペイン（docs/DESIGN.md §7.3）。
 *
 * **ここは差分本体だけ**を出す。コミット詳細と変更ファイル一覧は右ペイン
 * （`CommitInfo`）へ移した。**中身は T-13 で入る**ので、いまは器と見出しだけ置く。
 *
 * 取得は `useCommitFiles` が持っている（詳細・一覧と同じ 1 回の取得を分け合う）。
 */
import { ja } from "../../i18n/ja";
import type { CommitFiles } from "./useCommitFiles";

export function DiffPane({
  sha,
  selectedFile,
  files,
}: {
  sha: string | null;
  selectedFile: string | null;
  files: CommitFiles;
}) {
  const change = files.changes.find((entry) => entry.path === selectedFile) ?? null;

  return (
    // `tabIndex` は `Enter` でここへフォーカスを移すため（キーボードだけで差分へ入れる）。
    <div className="dpane" ref={files.bodyRef} tabIndex={-1}>
      {change !== null && (
        <header className="dpane__head">
          <span className="dpane__path">{change.path}</span>
          <span className="dpane__aside">{ja.diff.statusName[change.status]}</span>
          {change.oldPath !== null && (
            <span className="dpane__aside">{ja.diff.renamedFrom(change.oldPath)}</span>
          )}
        </header>
      )}

      {/* T-13 で差分本体が入る。 */}
      <div className="dpane__body">
        <p className="dpane__pending">
          {sha === null
            ? ja.diff.empty
            : selectedFile === null
              ? ja.diff.selectFile
              : ja.diff.bodyPending}
        </p>
        {files.loading && <p className="dpane__detail">{ja.diff.loading}</p>}
      </div>
    </div>
  );
}
