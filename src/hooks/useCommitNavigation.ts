/**
 * コミットリストのキーボード操作（docs/DESIGN.md §6.5）。
 *
 * VS Code 風を基本に、リスト移動だけ vim 風の `j` / `k` も受ける。
 * **入力欄にフォーカスがあるときは何もしない**（SHA ジャンプ欄で `j` が打てなくなる）。
 */
import { useCallback, useEffect, useState } from "react";

import { ja } from "../i18n/ja";
import type { ContextMenuItem } from "../components/common/ContextMenu";
import type { CommitMeta } from "../lib/ipc";

/** 親 / 子が複数あるときに出す選択メニュー。 */
export type NavigationChoice = { x: number; y: number; items: ContextMenuItem[] };

type Options = {
  /** 表示順のコミット。行番号はこの配列の添字。 */
  commits: CommitMeta[];
  indexBySha: Map<string, number>;
  selectedSha: string | null;
  headSha: string | null;
  onSelect: (sha: string) => void;
  /** その行が見えるところまでスクロールする。 */
  onReveal: (row: number) => void;
  /** 選択メニューを開く位置。行の画面上の座標を返す。 */
  anchorFor: (row: number) => { x: number; y: number };
  enabled: boolean;
};

export function useCommitNavigation({
  commits,
  indexBySha,
  selectedSha,
  headSha,
  onSelect,
  onReveal,
  anchorFor,
  enabled,
}: Options) {
  const [choice, setChoice] = useState<NavigationChoice | null>(null);

  const go = useCallback(
    (row: number) => {
      if (row < 0 || row >= commits.length) return;
      onSelect(commits[row].sha);
      onReveal(row);
    },
    [commits, onSelect, onReveal],
  );

  /** 候補が 1 つならそこへ、複数なら選ばせる。 */
  const follow = useCallback(
    (shas: string[], row: number, title: string) => {
      const rows = shas
        .map((sha) => indexBySha.get(sha))
        .filter((value): value is number => value !== undefined);

      if (rows.length === 0) return;
      if (rows.length === 1) {
        go(rows[0]);
        return;
      }

      const anchor = anchorFor(row);
      setChoice({
        x: anchor.x,
        y: anchor.y,
        items: rows.map((target) => ({
          label: `${title}: ${commits[target].shortSha} ${commits[target].subject.slice(0, 40)}`,
          onSelect: () => {
            setChoice(null);
            go(target);
          },
        })),
      });
    },
    [anchorFor, commits, go, indexBySha],
  );

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // 入力欄では横取りしない。
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const current = selectedSha === null ? -1 : (indexBySha.get(selectedSha) ?? -1);

      // Ctrl+H は HEAD へ。選択が無くても効く。
      if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "h") {
        const row = headSha === null ? undefined : indexBySha.get(headSha);
        if (row !== undefined) {
          event.preventDefault();
          go(row);
        }
        return;
      }

      if (event.ctrlKey || event.metaKey) return;

      if (event.altKey) {
        if (current < 0) return;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          follow(commits[current].parents, current, ja.commits.parent);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          follow(childrenOf(commits, indexBySha, current), current, ja.commits.child);
        }
        return;
      }

      switch (event.key) {
        case "ArrowDown":
        case "j":
          event.preventDefault();
          go(current < 0 ? 0 : current + 1);
          break;
        case "ArrowUp":
        case "k":
          event.preventDefault();
          go(current < 0 ? 0 : current - 1);
          break;
        case "Home":
          event.preventDefault();
          go(0);
          break;
        case "End":
          event.preventDefault();
          go(commits.length - 1);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commits, enabled, follow, go, headSha, indexBySha, selectedSha]);

  return { choice, closeChoice: () => setChoice(null) };
}

/**
 * `row` のコミットを親に持つコミット（＝子）。
 *
 * 子の索引は作らない。**子を辿るのはキーを押したときだけ**で、数万件の索引を
 * 常に持ち歩く価値がない。topo-order では子は必ず上にあるので、上へ向かって探す。
 */
function childrenOf(
  commits: CommitMeta[],
  indexBySha: Map<string, number>,
  row: number,
): string[] {
  const sha = commits[row].sha;
  const found: string[] = [];
  for (let i = row - 1; i >= 0; i -= 1) {
    if (commits[i].parents.includes(sha)) found.push(commits[i].sha);
  }
  // 呼び出し側が行番号に直せるよう、索引に載っているものだけ返す。
  return found.filter((child) => indexBySha.has(child));
}
