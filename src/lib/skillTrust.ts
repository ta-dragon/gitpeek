/**
 * skill 一覧と信頼操作の出し分け（T-21）。**純関数だけ。**
 *
 * `.tsx` に書いた判定にはテストが 1 つも当たらない（CLAUDE.md §8）。clone の
 * 「この保存先を次回から既定にする」は直書きしたせいで、条件が常に成立せず
 * **一度も表示されないまま**受け入れ条件を全部通した。
 *
 * **文言はここに書かない。** 返すのは「どういう状態か」だけで、日本語は
 * `i18n/ja.ts` が持つ（CLAUDE.md §6）。
 */
import type { RepoTrustStatus, SkillEntry, SkillOrigin } from "./ipc";

/**
 * 信頼まわりで押せる操作。
 *
 * **どの状態でもボタンを消さない**（CLAUDE.md §6）。消すと、いま何が効いているのか
 * 画面から読めなくなる。押せないときは押せない理由を添えて出す。
 *
 * - `noRepository` … リポジトリを開いていない
 * - `noSkills`     … このリポジトリに skill が無い
 * - `untrusted`    … まだ信頼していない（信頼できる）
 * - `recheck`      … 信頼済みだが変わった／増えた（確認し直せる）
 * - `trusted`      … 信頼済みで変化なし（取り消せる）
 */
export type TrustOption = {
  kind: "noRepository" | "noSkills" | "untrusted" | "recheck" | "trusted";
  /** 「信頼する」を押せるか。 */
  canTrust: boolean;
  /** 「信頼を取り消す」を押せるか。 */
  canUntrust: boolean;
};

export function trustOption(
  status: RepoTrustStatus,
  hasRepository: boolean,
): TrustOption {
  if (!hasRepository) {
    return { kind: "noRepository", canTrust: false, canUntrust: false };
  }
  if (!status.present) {
    // skill が無くても、**信頼したまま残っている記録は取り消せる**ようにしておく。
    // 取り消せないと、ファイルを消したあと信頼が残り続けていることに気付けない。
    return { kind: "noSkills", canTrust: false, canUntrust: status.trusted };
  }
  if (!status.trusted) {
    return { kind: "untrusted", canTrust: true, canUntrust: false };
  }
  if (status.needsRecheck) {
    return { kind: "recheck", canTrust: true, canUntrust: true };
  }
  return { kind: "trusted", canTrust: false, canUntrust: true };
}

/**
 * 信頼の確認画面で読ませる skill。
 *
 * **リポジトリ内のものだけを、読める・読めないに関わらず全部見せる。**
 * 読めないファイルを隠すと、「読めないものが 1 つ増えた」ことに気付けないまま
 * 信頼してしまう。
 */
export function skillsToReview(entries: SkillEntry[]): SkillEntry[] {
  return entries.filter((entry) => entry.origin === "repository");
}

/** 出どころごとの内訳。一覧の見出しに出す。 */
export type SkillCounts = {
  usable: number;
  untrusted: number;
  recheck: number;
  unreadable: number;
};

export function countSkills(entries: SkillEntry[]): SkillCounts {
  const counts: SkillCounts = { usable: 0, untrusted: 0, recheck: 0, unreadable: 0 };
  for (const entry of entries) {
    switch (entry.state.kind) {
      case "ready":
        // **隠されたものを「使える」に数えない。** 数と実際に効くものがずれる。
        if (entry.shadowedBy === null) counts.usable += 1;
        break;
      case "untrusted":
        counts.untrusted += 1;
        break;
      case "recheck":
        counts.recheck += 1;
        break;
      case "unreadable":
        counts.unreadable += 1;
        break;
    }
  }
  return counts;
}

/**
 * 1 件をどう見せるか。**状態と、隠されているかどうかは別**なので分けて返す。
 *
 * 隠されている（同名で負けた）ものは、それ自体は読めていても効かない。
 * 「読めているのに効かない」を黙って見せないこと。
 */
export type SkillDisplay = {
  /** 効いているか。**これが false なら理由が必ずある。** */
  effective: boolean;
  /** 状態の見出し。 */
  state: SkillEntry["state"]["kind"];
  /** 読めない理由。読めているときは null。 */
  reason: string | null;
  /** 同名で押しのけた側の出どころ。押しのけられていなければ null。 */
  shadowedBy: SkillOrigin | null;
  /** 編集できるか（内蔵は不可）。 */
  editable: boolean;
};

export function skillDisplay(entry: SkillEntry): SkillDisplay {
  const shadowedBy = entry.shadowedBy;
  return {
    effective: entry.state.kind === "ready" && shadowedBy === null,
    state: entry.state.kind,
    reason: entry.state.kind === "unreadable" ? entry.state.reason : null,
    shadowedBy,
    editable: entry.origin !== "builtIn",
  };
}

/**
 * 変わったもの・増えたものの一覧を 1 本にまとめる。
 *
 * **増えたほうを先に出す。** 信頼させたあとに置かれたファイルのほうが、
 * 内容が変わったファイルより危ない。
 */
export function recheckReasons(status: RepoTrustStatus): {
  added: string[];
  changed: string[];
} {
  return { added: status.added, changed: status.changed };
}
