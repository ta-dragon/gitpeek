import type { ReactNode } from "react";

/**
 * 左サイドバーの枠（docs/DESIGN.md §6.1）。
 *
 * 上段がリポジトリ一覧、下段がブランチ / タグツリー。
 * **下段が伸び縮みの主役**で、上段は中身なりの高さ（サイドバーの半分まで）に収める。
 * リポジトリは数十件だがブランチとタグは数千件になりうるので、余った縦を下段へ渡す。
 */
export function Sidebar({ repositories, refs }: { repositories: ReactNode; refs?: ReactNode }) {
  return (
    <aside className="sidebar">
      <div className="sidebar__top">{repositories}</div>
      <div className="sidebar__bottom">{refs}</div>
    </aside>
  );
}
