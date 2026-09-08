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
import type {
  CheckoutTarget,
  FetchMergeOutcome,
  FetchStatus,
  RefEntry,
} from "./ipc";

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
  | { can: false; why: MergeBlockReason };

/** 取り込めない理由。**文言は `i18n/ja.ts`**（CLAUDE.md §6）。 */
export type MergeBlockReason = "detached" | "unknown" | "ahead" | "upToDate";

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

/**
 * 「取ってきて取り込む」の結果を**どの段で止まったか**に畳む（T-31。DESIGN.md §8.6）。
 *
 * 結果は 4 つの `null` になりうるフィールドで届くので、そのまま `.tsx` で
 * 場合分けすると判定にテストが 1 つも当たらない（CLAUDE.md §8）。文言は返さない —
 * 種別だけ返し、文字列は `i18n/ja.ts` が持つ（CLAUDE.md §6）。
 *
 * **取り込まなかった理由は `mergeVerdict` を使い回す。** 確認画面と結果画面で
 * 別の言い方をすると、同じ状態が 2 通りに読める。
 */
export type FetchMergeStage =
  /** 判定が通らず、**fetch もしていない。** */
  | { stage: "refused" }
  /** 取ってくるところで止まった（失敗 / 中止）。**取り込んでいない。** */
  | { stage: "fetchStopped"; status: FetchStatus }
  /** 取ってきたが、取り込めなかった。 */
  | { stage: "notMerged"; why: MergeBlockReason }
  /** 取り込みを走らせた。 */
  | { stage: "merged"; ok: boolean };

export function fetchMergeStage(outcome: FetchMergeOutcome): FetchMergeStage {
  if (outcome.refused !== null || outcome.fetch === null) return { stage: "refused" };

  // **中止と失敗は「取り込まなかった」だけでなく「取ってこられなかった」。**
  // ここを一緒にすると、fetch が失敗したのに「取り込むものがありません」と出る。
  if (outcome.fetch.status === "failed" || outcome.fetch.status === "cancelled") {
    return { stage: "fetchStopped", status: outcome.fetch.status };
  }

  if (outcome.merge !== null) return { stage: "merged", ok: outcome.merge.ok };

  // 判定が無いのは Rust 側が形を変えたときだけ。**握り潰さず「判定できない」に寄せる。**
  if (outcome.check === null) return { stage: "notMerged", why: "unknown" };

  const verdict = mergeVerdict(outcome.check, outcome.check.detached);
  return { stage: "notMerged", why: verdict.can ? "unknown" : verdict.why };
}

/** 結果に添える生の行。**fetch の分と取り込みの分を落とさずに繋ぐ。** */
export function fetchMergeDetails(outcome: FetchMergeOutcome): string[] {
  return [...(outcome.fetch?.lines ?? []), ...(outcome.merge?.details ?? [])];
}
