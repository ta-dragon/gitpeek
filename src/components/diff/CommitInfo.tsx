/**
 * 右ペイン — コミット詳細と変更ファイル一覧（docs/DESIGN.md §7.3）。
 *
 * **差分本体とは別の列に置く**（3 ペイン）。同じ列に縦積みしていたときは、
 * 詳細と一覧が高さを食って差分本体が数行しか残らなかった。ここは縦に長い列なので、
 * 一覧が伸びても差分の幅と高さを削らない。
 */
import { useState } from "react";

import { ja } from "../../i18n/ja";
import { CommitDetail } from "./CommitDetail";
import { FileList, type FileListLayout } from "./FileList";
import type { CommitFiles } from "./useCommitFiles";

export function CommitInfo({
  sha,
  files,
  selectedFile,
  onSelectFile,
  onNotice,
}: {
  /** 選択中のコミット。`null` なら案内だけ出す。 */
  sha: string | null;
  files: CommitFiles;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  onNotice: (message: string) => void;
}) {
  const [layout, setLayout] = useState<FileListLayout>("flat");

  if (sha === null) {
    return (
      <div className="cinfo cinfo--empty">
        <p>{ja.diff.empty}</p>
      </div>
    );
  }

  if (files.error !== null) {
    return (
      <div className="cinfo cinfo--empty">
        <p className="cinfo__error">{ja.diff.failed}</p>
        <p className="cinfo__detail">{files.error}</p>
        <button type="button" className="button" onClick={files.retry}>
          {ja.diff.retry}
        </button>
      </div>
    );
  }

  const detail = files.detail;
  if (detail === null) {
    return (
      <div className="cinfo cinfo--empty">
        <p>{ja.diff.loading}</p>
      </div>
    );
  }

  return (
    <div className="cinfo">
      <CommitDetail
        detail={detail}
        parentIndex={files.parentIndex}
        parentsInGraph={files.parentsInGraph}
        onParentChange={files.setParentIndex}
        onCopySha={(text) => void copyText(text, onNotice)}
      />

      <FileList
        changes={files.changes}
        selectedPath={selectedFile}
        layout={layout}
        onSelect={onSelectFile}
        onLayoutChange={setLayout}
      />
    </div>
  );
}

/**
 * クリップボードへ書く（`RefTree` と同じ理由でプラグインを入れない）。
 * 失敗したときは黙らず通知する。
 */
async function copyText(text: string, onNotice: (message: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    onNotice(ja.diff.copied(text));
  } catch {
    onNotice(ja.diff.copyFailed);
  }
}
