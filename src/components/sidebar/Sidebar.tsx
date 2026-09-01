import type { ReactNode } from "react";

/**
 * 左サイドバーの枠（docs/DESIGN.md §6.1）。
 *
 * 上段がリポジトリ一覧、下段がブランチ / タグツリー。
 * 下段の中身は T-10 で入るので、いまは場所だけ確保する。
 */
export function Sidebar({ repositories, refs }: { repositories: ReactNode; refs?: ReactNode }) {
  return (
    <aside className="sidebar">
      <div className="sidebar__top">{repositories}</div>
      <div className="sidebar__bottom">{refs}</div>
    </aside>
  );
}
