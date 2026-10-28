/**
 * 見ている stash の変更ファイルと、選んでいるファイル（T-42。docs/DESIGN.md §7.5.1）。
 *
 * **コミットの選択（`useCommitFiles`）には乗せない。** stash はマージコミットなので、乗せると
 * 親を選ぶドロップダウンが出て、index や未追跡だけの親との差分を選べてしまう。作業ツリーと同じく
 * 別の形で持ち、差分ペインへ渡す 2 点もここで決める（`lib/stash.ts`）。
 *
 * 取得は 2 本（追跡ぶん「元のコミット → stash」と、未追跡ぶん「ルート → 第 3 親」）。
 * **選んだファイルは残さない**（stash ごとに中身が違う）。
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { useFileNavigation } from "../../hooks/useFileNavigation";
import { loadChangedFiles, type DiffSource, type FileChange, type StashEntry } from "../../lib/ipc";
import {
  parseStashFileKey,
  stashFileKey,
  stashSource,
  type StashSection,
} from "../../lib/stash";

export type StashFiles = {
  tracked: FileChange[];
  /** 未追跡ぶん。`-u` で退避していなければ空。 */
  untracked: FileChange[];
  loading: boolean;
  error: string | null;
  selected: { section: StashSection; path: string } | null;
  select: (section: StashSection, path: string) => void;
  /** 差分ペインへ渡す 2 点と、選んでいるファイル。 */
  source: DiffSource | null;
  change: FileChange | null;
};

const NONE: FileChange[] = [];

export function useStashFiles({
  repositoryId,
  entry,
  focusRef,
}: {
  repositoryId: string;
  /** 見ている stash。null なら何も取らない。 */
  entry: StashEntry | null;
  focusRef: RefObject<HTMLDivElement | null>;
}): StashFiles {
  const [tracked, setTracked] = useState<FileChange[]>(NONE);
  const [untracked, setUntracked] = useState<FileChange[]>(NONE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const latest = useRef(0);

  // **依存には素の値を並べる**（`entry` は読み直すたびに作り直される）。
  const sha = entry?.sha ?? null;
  const base = entry?.base ?? null;
  const untrackedSha = entry?.untracked ?? null;

  useEffect(() => {
    const request = (latest.current += 1);
    setTracked(NONE);
    setUntracked(NONE);
    setSelectedKey(null);
    setError(null);
    if (sha === null || base === null) {
      setLoading(false);
      return;
    }

    setLoading(true);
    void (async () => {
      try {
        const [files, extra] = await Promise.all([
          loadChangedFiles(repositoryId, sha, base),
          untrackedSha === null ? Promise.resolve(NONE) : loadChangedFiles(repositoryId, untrackedSha, null),
        ]);
        if (request !== latest.current) return;
        setTracked(files.length === 0 ? NONE : files);
        setUntracked(extra.length === 0 ? NONE : extra);
        // 先頭を選ぶ。追跡ぶんが無い（未追跡だけを退避した）ときは未追跡の先頭。
        const first =
          files.length > 0
            ? stashFileKey("tracked", files[0].path)
            : extra.length > 0
              ? stashFileKey("untracked", extra[0].path)
              : null;
        setSelectedKey(first);
        setLoading(false);
      } catch (caught) {
        if (request !== latest.current) return;
        setLoading(false);
        setError(typeof caught === "string" ? caught : String(caught));
      }
    })();
  }, [repositoryId, sha, base, untrackedSha]);

  const keys = useMemo(
    () => [
      ...tracked.map((change) => stashFileKey("tracked", change.path)),
      ...untracked.map((change) => stashFileKey("untracked", change.path)),
    ],
    [tracked, untracked],
  );
  // `Alt+↑` / `Alt+↓` と `Enter`（コミット・作業ツリーの一覧と同じ）。見ていないときは鍵が空。
  useFileNavigation({ keys, selected: selectedKey, onSelect: setSelectedKey, focusRef });

  const selected = selectedKey === null ? null : parseStashFileKey(selectedKey);
  const change =
    selected === null
      ? null
      : ((selected.section === "tracked" ? tracked : untracked).find(
          (item) => item.path === selected.path,
        ) ?? null);
  const source = entry === null || selected === null ? null : stashSource(entry, selected.section);

  return {
    tracked,
    untracked,
    loading,
    error,
    selected,
    select: (section, path) => setSelectedKey(stashFileKey(section, path)),
    source,
    change,
  };
}
