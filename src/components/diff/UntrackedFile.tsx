/**
 * 未追跡ファイルの全文（docs/DESIGN.md §7.5）。
 *
 * **差分としては見せない。** 全行が追加された差分は視覚的ノイズが大きすぎるし、
 * 「まだ git が知らないファイル」という事実がかえって伝わらない。
 *
 * ハイライトは付けない。**差分ではないので語単位の対応付けも要らず**、
 * ここだけのために Shiki の経路をもう 1 本作る価値がない。
 */
import { useEffect, useState } from "react";

import { ja } from "../../i18n/ja";
import { formatBytes } from "../../lib/diffRows";
import { loadWorkingFile, type WorkingFile } from "../../lib/ipc";

export function UntrackedFile({
  repositoryId,
  path,
}: {
  repositoryId: string;
  path: string;
}) {
  const [file, setFile] = useState<WorkingFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setFile(null);
    setError(null);

    void loadWorkingFile(repositoryId, path)
      .then((loaded) => {
        if (current) setFile(loaded);
      })
      .catch((caught: unknown) => {
        if (current) setError(messageOf(caught));
      });

    return () => {
      current = false;
    };
  }, [repositoryId, path]);

  if (error !== null) {
    return (
      <div className="dpane__notice">
        <p className="dpane__error">{ja.workingTree.readFailed}</p>
        <p className="dpane__detail">{error}</p>
      </div>
    );
  }

  if (file === null) return <p className="dpane__pending">{ja.diff.loading}</p>;

  if (file.tooLarge) {
    return (
      <div className="dpane__notice">
        <p className="dpane__pending">{ja.workingTree.tooLarge(formatBytes(file.size))}</p>
      </div>
    );
  }

  if (file.binary || file.text === null) {
    return (
      <div className="dpane__notice">
        <p className="dpane__pending">{ja.diff.binaryBody}</p>
        <p className="dpane__detail">{formatBytes(file.size)}</p>
      </div>
    );
  }

  const lines = file.text.text.split("\n");

  return (
    <div className="dtable dtable--plain">
      {lines.map((line, index) => (
        <div className="drow drow--plain" key={index}>
          <span className="dline__no">{index + 1}</span>
          <span className="dline">
            <span className="dline__text">{line}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : String(error);
}
