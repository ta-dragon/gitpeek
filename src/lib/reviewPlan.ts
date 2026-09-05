/**
 * 実行前パネルの出し分け（T-23。純関数）。
 *
 * **判定をコンポーネントに直書きしない**（CLAUDE.md §8）。フロントは純関数だけ
 * テストする決まりなので、`.tsx` に書いた条件は誰も見ていない。clone の
 * 「この保存先を次回から既定にする」は直書きしたせいで、**条件が常に成立せず
 * 一度も表示されないまま**受け入れ条件を全部通した（T-19）。
 *
 * **見積もりも分割数もここで計算し直さない。** `ReviewPlan` に入っている
 * Rust 側の数をそのまま出す（DESIGN.md §10.7.1）。ここがやるのは
 * 「押せるか」「何と書くか」だけ。
 */
import { ja } from "../i18n/ja";
import type { LlmProfile, PlannedFile, ReviewIndexRow, ReviewPlan } from "./ipc";

/**
 * 実行ボタンの状態。
 *
 * **押せないときも選択肢を消さない**（CLAUDE.md §6）。押せない理由と
 * いまの値を文言に出すため、`reason` は `enabled` が false のときだけ入る。
 */
export type RunGate = { enabled: boolean; reason: string | null };

/** いま走っているレビューの有無。**2 本走らせない**ための入力。 */
export type RunningState = { running: boolean };

/**
 * 実行できるか。**押せる条件でだけボタンを出さない。**
 *
 * 見る順番は「そもそも計画が立たない → 接続先が無い → もう走っている →
 * 全部外した」。**先に効く理由を先に出す** — 「接続先がありません」と
 * 「ファイルを 1 つ以上選んでください」が同時に成り立つとき、
 * 後者だけ出すと接続先を足しても押せないままで理由が読めない。
 */
export function runGate(
  plan: ReviewPlan | null,
  profiles: LlmProfile[],
  selected: string[],
  state: RunningState,
): RunGate {
  if (plan === null) {
    return { enabled: false, reason: ja.review.gate.noPlan };
  }
  if (plan.blocked !== null) {
    return { enabled: false, reason: plan.blocked };
  }
  if (profiles.length === 0) {
    return { enabled: false, reason: ja.review.gate.noProfile };
  }
  if (state.running) {
    return { enabled: false, reason: ja.review.gate.alreadyRunning };
  }
  if (selected.length === 0) {
    return { enabled: false, reason: ja.review.gate.nothingSelected };
  }
  return { enabled: true, reason: null };
}

/**
 * 既定で選んでおくファイル。**投げられないものは選ばない。**
 *
 * `skipped` が入っているファイルは Rust 側が投げないと決めたもので、
 * チェックを付けても意味が無い（一覧からは消さない）。
 */
export function defaultSelection(plan: ReviewPlan | null): string[] {
  if (plan === null) return [];
  return plan.files.filter((file) => file.skipped === null).map((file) => file.path);
}

/** 選べるファイルか。**`skipped` のものはチェックボックスを操作させない。** */
export function selectable(file: PlannedFile): boolean {
  return file.skipped === null;
}

/**
 * ファイル 1 行に添える注記。無ければ `null`。
 *
 * **用語をそのまま出さない**（CLAUDE.md §6）。「hunk 分割」は通じないので
 * 「大きいので N 回に分けて送ります」と書く。
 */
export function fileNote(file: PlannedFile): string | null {
  if (file.skipped !== null) return file.skipped;
  if (file.parts >= 2) return ja.review.plan.splitInto(file.parts);
  return null;
}

/** 送るファイルの数と、送らないファイルの数。 */
export function planCounts(plan: ReviewPlan | null): { sending: number; skipped: number } {
  if (plan === null) return { sending: 0, skipped: 0 };
  return {
    sending: plan.files.filter((file) => file.skipped === null).length,
    skipped: plan.files.filter((file) => file.skipped !== null).length,
  };
}

/**
 * 選んだファイルぶんの概算トークン数。
 *
 * **Rust の数を足すだけ。** 文字数から数え直さない（同じ規則を 2 か所に置くと
 * 必ずずれる。DESIGN.md §10.7.1）。
 */
export function selectedTokens(plan: ReviewPlan | null, selected: string[]): number {
  if (plan === null) return 0;
  const wanted = new Set(selected);
  return plan.files
    .filter((file) => file.skipped === null && wanted.has(file.path))
    .reduce((total, file) => total + file.tokensEstimate, 0);
}

/**
 * どの接続先を最初に選んでおくか。
 *
 * リポジトリの既定 → 1 つしか無ければそれ → どれも決まらなければ `null`。
 * **`null` のときは画面が「選んでください」と出す**（勝手に 1 つ目を選ばない —
 * 選ばれているように見えて別の接続先へ投げるほうが困る）。
 */
export function initialProfile(
  profiles: LlmProfile[],
  repositoryDefault: string | null,
): string | null {
  if (repositoryDefault !== null && profiles.some((it) => it.id === repositoryDefault)) {
    return repositoryDefault;
  }
  if (profiles.length === 1) return profiles[0].id;
  return null;
}

/** 履歴 1 行の見出し。**中止と失敗は必ず出す。** */
export function historyLabel(row: ReviewIndexRow): string {
  if (row.unreadable !== null) return ja.review.history.unreadable;

  const parts = [ja.review.history.findings(row.findings)];
  if (row.failed > 0) parts.push(ja.review.history.failed(row.failed));
  if (row.cancelled) parts.push(ja.review.history.cancelled);
  return parts.join(" / ");
}

/**
 * 保存時刻を画面に出す形にする。
 *
 * **読めない値でも落とさない。** 手で置かれたファイルや壊れた行でも
 * 一覧は出したいので、解釈できなければそのまま返す。
 */
export function historyTime(savedAt: string): string {
  if (savedAt === "") return "";
  const at = new Date(savedAt);
  if (Number.isNaN(at.getTime())) return savedAt;
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}
