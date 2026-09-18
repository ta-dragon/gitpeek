/**
 * 取り込まれているか（T-38）の結果を文言へ引き当てる。**判定はしない。**
 *
 * どの印を出すか・押せるかは `lib/containment.ts` の純関数が決め、ここは `ja.ts` を引くだけ
 * （`refMenu.ts` と同じ役割分担）。ブランチ一覧・チップ・ダイアログの 3 か所が同じ文を使う。
 */
import { ja } from "../../i18n/ja";
import {
  canCheckContainment,
  canFindContainers,
  squashOf,
  type ContainmentView,
} from "../../lib/containment";
import type { RefEntry } from "../../lib/ipc";
import { openContainers, requestCheck } from "../../store/containment";
import type { ContextMenuItem } from "./ContextMenu";

/** 画面に出す短い SHA。 */
function short(sha: string): string {
  return sha.slice(0, 8);
}

/** 印の文字（ブランチ一覧）。 */
export function markText(view: ContainmentView): string {
  switch (view.mark) {
    case "merged":
      return ja.containment.mark.merged;
    case "contained":
      return ja.containment.mark.contained;
    case "partial":
      return ja.containment.mark.partial(view.upto, view.total);
    case "changed":
      return ja.containment.mark.changed;
    case "failed":
      return ja.containment.mark.failed;
  }
}

/** 印の文字（チップ。幅が無いので記号）。 */
export function chipMarkText(view: ContainmentView): string {
  return ja.containment.chipMark[view.mark];
}

/** ホバーの根拠。1 行目が結論。**中身で判断していることを必ず添える。** */
export function hintText(
  view: ContainmentView,
  target: string,
  /** 印のホバーでは「クリックで移動」を添える。ダイアログはボタンがあるので添えない。 */
  jumpHint = true,
): string {
  const lines: string[] = [];
  switch (view.mark) {
    case "merged":
      lines.push(ja.containment.merged(target));
      break;
    case "contained":
      lines.push(
        view.squash === null
          ? ja.containment.containedNoSquash(target)
          : ja.containment.contained(target, short(view.squash)),
      );
      break;
    case "partial":
      lines.push(ja.containment.partial(target, view.upto, view.total));
      if (view.squash !== null) lines.push(ja.containment.partialSquash(short(view.squash)));
      break;
    case "changed":
      lines.push(ja.containment.changed(target, short(view.squash)));
      break;
    case "failed":
      return ja.containment.failed(target, view.reason);
  }
  if (view.mark !== "merged") lines.push(ja.containment.byContent);
  const squash = squashOf(view);
  if (jumpHint && squash !== null) lines.push(ja.containment.jumpHint(short(squash)));
  return lines.join("\n");
}

function whyText(why: "tag" | "outOfGraph" | "isTarget" | "noTarget"): string {
  switch (why) {
    case "tag":
      return ja.containment.whyTag;
    case "outOfGraph":
      return ja.containment.whyOutOfGraph;
    case "isTarget":
      return ja.containment.whyIsTarget;
    case "noTarget":
      return ja.containment.whyNoTarget;
  }
}

/**
 * 右クリックの 2 項目。**ブランチ一覧とチップの 2 か所に同じものを配る**（T-31 の `fetchMergeItem` と同じ）。
 * **押せなくても消さない**（CLAUDE.md §6）。
 */
export function containmentMenuItems(
  entry: RefEntry,
  /** 印の相手（幹）の完全な名前と短い名前。決まらなければ null。 */
  target: { name: string; label: string } | null,
): ContextMenuItem[] {
  const check = canCheckContainment(entry, target?.name ?? null);
  const find = canFindContainers(entry);
  return [
    {
      label: target === null ? ja.containment.checkNoTarget : ja.containment.check(target.label),
      disabled: !check.enabled,
      title: check.why === null ? ja.containment.checkHint : whyText(check.why),
      onSelect: () => requestCheck(entry.name),
    },
    {
      label: ja.containment.findContainers,
      disabled: !find.enabled,
      title: find.why === null ? ja.containment.findContainersHint : whyText(find.why),
      onSelect: () => openContainers(entry),
    },
  ];
}

