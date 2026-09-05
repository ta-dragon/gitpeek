/**
 * skill 一覧の出し分け（T-21）。**純関数だけ。**
 *
 * `.tsx` に書いた判定にはテストが 1 つも当たらない（CLAUDE.md §8）。clone の
 * 「この保存先を次回から既定にする」は直書きしたせいで、条件が常に成立せず
 * **一度も表示されないまま**受け入れ条件を全部通した。
 *
 * **文言はここに書かない。** 返すのは「どういう状態か」だけで、日本語は
 * `i18n/ja.ts` が持つ（CLAUDE.md §6）。
 */
import type { SkillEntry, SkillOrigin, SkillTarget } from "./ipc";

/**
 * 「このスキルを使う」を押したときに何が起きるか。
 *
 * **どの状態でもボタンを消さない**（CLAUDE.md §6）。押せないときは押せない理由を出す。
 *
 * - `use`      … 使う（リポジトリ内なら、いま読んでいる内容を信頼することでもある）
 * - `stop`     … 使うのをやめる
 * - `unreadable` … 読めないので使えない
 * - `shadowed` … 同名の別の skill が優先されているので、使っても効かない
 */
export type UseAction = {
  kind: "use" | "stop" | "unreadable" | "shadowed";
  /** 押せるか。 */
  enabled: boolean;
  /** 押したあと「使う」になるか。押せないときも、いまの値として意味がある。 */
  next: boolean;
};

export function useAction(entry: SkillEntry): UseAction {
  if (entry.state.kind === "unreadable") {
    return { kind: "unreadable", enabled: false, next: false };
  }
  // **効かないものを「使う」にできてしまうと、使っているつもりで効かない。**
  if (entry.shadowedBy !== null) {
    return { kind: "shadowed", enabled: false, next: !entry.inUse };
  }
  return entry.inUse
    ? { kind: "stop", enabled: true, next: false }
    : { kind: "use", enabled: true, next: true };
}

/**
 * その skill を指す宛先。
 *
 * **内蔵とグローバルは名前で、リポジトリ内はファイル名で指す**（Rust 側と同じ規則）。
 * リポジトリ内は「どのファイルの内容を信頼したか」が要点なので、frontmatter の
 * `name` を書き換えても記録が付いて回らないようにファイル名を鍵にする。
 *
 * リポジトリを開いていないのにリポジトリ内 skill を指すことはできないので `null`。
 */
export function targetOf(entry: SkillEntry, repositoryId: string | null): SkillTarget | null {
  if (entry.origin !== "repository") {
    return { scope: "global", name: entry.name };
  }
  if (repositoryId === null) return null;
  return { scope: "repository", repositoryId, file: entry.file };
}

/** 出どころで絞る。画面が 2 つに分かれたので、どちらも同じ関数から取る。 */
export function skillsFrom(entries: SkillEntry[], origins: SkillOrigin[]): SkillEntry[] {
  return entries.filter((entry) => origins.includes(entry.origin));
}

/** 一覧の見出しに出す内訳。 */
export type SkillCounts = {
  inUse: number;
  undecided: number;
  changed: number;
  unreadable: number;
};

export function countSkills(entries: SkillEntry[]): SkillCounts {
  const counts: SkillCounts = { inUse: 0, undecided: 0, changed: 0, unreadable: 0 };
  for (const entry of entries) {
    if (entry.state.kind === "unreadable") {
      counts.unreadable += 1;
    } else if (entry.state.kind === "recheck") {
      counts.changed += 1;
    } else if (entry.state.kind === "untrusted") {
      counts.undecided += 1;
      // **押しのけられたものを「使う」に数えない。** 数と実際に効くものがずれる。
    } else if (entry.inUse && entry.shadowedBy === null) {
      counts.inUse += 1;
    } else {
      counts.undecided += 1;
    }
  }
  return counts;
}

/**
 * 1 件をどう見せるか。**状態・効いているか・誰が決めたかは別物**なので分けて返す。
 */
export type SkillDisplay = {
  /** 実際に効いているか。**false なら理由が必ずある。** */
  effective: boolean;
  state: SkillEntry["state"]["kind"];
  /** 読めない理由。読めているときは null。 */
  reason: string | null;
  /** 同名で押しのけた側の出どころ。押しのけられていなければ null。 */
  shadowedBy: SkillOrigin | null;
  /** 使う／使わないを利用者が決めたか。false ならファイルの既定のまま。 */
  decidedByUser: boolean;
  /** **決める前に本文を読ませる必要があるか。** リポジトリ内で未決・変更ありのとき。 */
  mustRead: boolean;
};

export function skillDisplay(entry: SkillEntry): SkillDisplay {
  const held = entry.state.kind === "untrusted" || entry.state.kind === "recheck";
  return {
    effective: entry.state.kind === "ready" && entry.inUse && entry.shadowedBy === null,
    state: entry.state.kind,
    reason: entry.state.kind === "unreadable" ? entry.state.reason : null,
    shadowedBy: entry.shadowedBy,
    decidedByUser: entry.decidedByUser,
    // **読ませずに使わせない。** 決めていない／変わったものは本文を開いた状態で出す。
    mustRead: held,
  };
}

/**
 * 「追加の指示」を保存すべきか。
 *
 * **前後の空白だけの違いで書きに行かない。** 入力のたびに `settings.json` を
 * 書き換えると、手編集しているファイルが常時上書きされる（DESIGN.md §12.2）。
 */
export function extraChanged(current: string, next: string): boolean {
  return current.trim() !== next.trim();
}
