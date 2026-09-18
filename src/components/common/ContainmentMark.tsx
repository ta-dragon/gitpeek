/**
 * ブランチが取り込まれているかの印（T-38。docs/DESIGN.md §7.6）。
 *
 * ブランチ一覧（`sidebar/RefTreeNode.tsx`）とチップ（`commits/RefChips.tsx`）の 2 か所に置く。
 * **結果はストア（`store/containment.ts`）から読む** — 行ごとに props で配ると、グラフの行を
 * 描く経路を何段も通すことになる。**どの印を出すかは `lib/containment.ts` の純関数。**
 *
 * **グラフとレーンには触らない**（CLAUDE.md §3）。
 */
import { containmentView, refLabel, resultFor, squashOf } from "../../lib/containment";
import type { RefEntry } from "../../lib/ipc";
import { useContainment } from "../../store/containment";
import { useSnapshot } from "../../store/snapshot";
import { chipMarkText, hintText, markText } from "./containmentText";

export function ContainmentMark({
  entry,
  variant,
  onJumpSquash,
}: {
  entry: RefEntry;
  /** `tree` は文字で、`chip` は幅が無いので記号で出す。 */
  variant: "tree" | "chip";
  /** 印のクリックで squash コミットへ。**飛べない理由は呼ぶ側が出す。** */
  onJumpSquash: (sha: string) => void;
}) {
  const containment = useContainment();
  const snapshot = useSnapshot();
  const data = snapshot.data;
  const target = containment.target;

  // 別のリポジトリの結果を出さない（切り替えの直後）。
  if (data === null || containment.repositoryId !== snapshot.repositoryId || target === null) {
    return null;
  }
  const view = containmentView(resultFor(entry.name, target, data.refs, containment.cache));
  if (view === null) return null;

  const squash = squashOf(view);
  const title = hintText(view, refLabel(data.refs, target));

  return (
    <button
      type="button"
      className={`containment containment--${variant} containment--${view.mark}`}
      title={title}
      aria-label={title}
      // 飛び先が無い種類は押しても何も起きないので、押せる見た目にしない。
      data-jumpable={squash !== null}
      onClick={(event) => {
        // チップは行の中にあり、ブランチ一覧の行はクリックでジャンプする。**行へ流さない。**
        event.stopPropagation();
        if (squash !== null) onJumpSquash(squash);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {variant === "tree" ? markText(view) : chipMarkText(view)}
    </button>
  );
}
