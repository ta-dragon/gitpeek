/**
 * checkout の選択肢を組み立てる純関数（T-18。docs/DESIGN.md §8.1）。
 *
 * **「何を選ばせるか」を決めるのはここだけ。** 起動点が 4 つある
 * （ref ツリーの右クリック / ダブルクリック / グラフ行の右クリック / 上流の取り込み）ので、
 * ボタンの側で分岐させると結論が食い違う。
 *
 * **対象の渡し方は形で変わる**（DESIGN.md §8.1。実測）。
 * ローカルブランチは短い名前、それ以外は完全な ref 名 ＋ `--detach`。
 * ここで取り違えると、git が**ローカル追跡ブランチを勝手に作る**（CLAUDE.md §1 違反）。
 */
import type { CheckoutTarget, RefEntry } from "./ipc";

/** 確認画面に並べる 1 つの選択肢。 */
export type CheckoutChoice = {
  target: CheckoutTarget;
  /** どれを既定の見た目にするか。**1 つだけ true。** */
  primary: boolean;
  /** 文言を引くための種別。**文字列そのものは `i18n/ja.ts`**（CLAUDE.md §6）。 */
  kind: "switch" | "track" | "detach";
  /** 文言に差し込む名前。 */
  name: string;
};

/**
 * `refs/remotes/origin/feature` から作るローカルブランチ名（`feature`）。
 *
 * リモート名は 1 段だけ剥がす。**ブランチ名にはスラッシュが入りうる**ので
 * （`feature/x`）、最後の `/` で切ってはいけない。
 */
export function localBranchName(remoteRefName: string): string {
  const rest = remoteRefName.startsWith(REMOTE_PREFIX)
    ? remoteRefName.slice(REMOTE_PREFIX.length)
    : remoteRefName;
  const slash = rest.indexOf("/");
  return slash < 0 ? rest : rest.slice(slash + 1);
}

const REMOTE_PREFIX = "refs/remotes/";

/**
 * この ref をどう checkout できるか。
 *
 * - ローカルブランチ … そのブランチへ切り替えるだけ
 * - リモート追跡ブランチ … **ローカルブランチを作る** か **detached で開く**
 *   （作るのは利用者が選んだときだけ。自動では作らない — CLAUDE.md §1）。
 *   同じ名前のローカルブランチが既にあれば、作らずにそちらへ切り替える
 * - タグ … detached で開くだけ
 */
export function checkoutChoices(entry: RefEntry, refs: RefEntry[]): CheckoutChoice[] {
  if (entry.kind === "localBranch") {
    return [
      {
        target: { kind: "branch", name: entry.shortName },
        primary: true,
        kind: "switch",
        name: entry.shortName,
      },
    ];
  }

  const detach: CheckoutChoice = {
    target: { kind: "detach", rev: entry.name },
    primary: entry.kind === "tag",
    kind: "detach",
    name: entry.shortName,
  };

  if (entry.kind === "tag") return [detach];

  const branch = localBranchName(entry.name);
  const existing = refs.find(
    (candidate) => candidate.kind === "localBranch" && candidate.shortName === branch,
  );

  // 既にあるなら作らない。**`checkout -b` は既存の名前では失敗する**ので、
  // ここを間違えると「失敗しました」しか出せなくなる。
  if (existing !== undefined) {
    return [
      {
        target: { kind: "branch", name: existing.shortName },
        primary: true,
        kind: "switch",
        name: existing.shortName,
      },
      detach,
    ];
  }

  return [
    {
      target: { kind: "track", remoteRef: entry.name, branch },
      primary: true,
      kind: "track",
      name: branch,
    },
    detach,
  ];
}

/** そのコミットを detached で開く。グラフ行の右クリックから使う。 */
export function checkoutCommit(sha: string): CheckoutTarget {
  return { kind: "detach", rev: sha };
}

/**
 * 現在のブランチへ `ref` を fast-forward で取り込めるか。
 *
 * **取り込めるのは「HEAD が相手の祖先」のときだけ。** ahead が 1 でもあれば
 * fast-forward にならないので実行しない（CLAUDE.md §1 — 非 FF マージは提供しない）。
 */
export type MergeVerdict =
  | { can: true; behind: number }
  | { can: false; why: "detached" | "unknown" | "ahead" | "upToDate" };

export function mergeVerdict(
  check: { ahead: number; behind: number; known: boolean },
  detachedHead: boolean,
): MergeVerdict {
  // detached では取り込む先のブランチが無い（DESIGN.md §8.2）。
  if (detachedHead) return { can: false, why: "detached" };
  if (!check.known) return { can: false, why: "unknown" };
  if (check.ahead > 0) return { can: false, why: "ahead" };
  if (check.behind === 0) return { can: false, why: "upToDate" };
  return { can: true, behind: check.behind };
}
