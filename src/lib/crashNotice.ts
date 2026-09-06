/**
 * 落ちたときに何を出すか（T-24。純関数）。
 *
 * **判定をコンポーネントに直書きしない**（CLAUDE.md §8）。フロントは純関数だけ
 * テストする決まりなので、`.tsx` に書いた条件は誰も見ていない。
 *
 * ここが決めるのは 2 つだけ。
 *
 * - ログの場所をどう案内するか（**書けていないときは、そう言う**）
 * - 落ちた理由をどう 1 行にするか
 */
import { ja } from "../i18n/ja";
import type { LogStatus } from "./ipc";

/** ログの案内文と、「フォルダを開く」を押せるか。 */
export type LogHint = { text: string; canOpen: boolean };

/**
 * ログの場所の案内。
 *
 * **無い場所を案内しない。** 書けていないのに「ここに記録があります」と出すと、
 * 開いて空だったときに何が起きたのか分からなくなる。
 * 書けていなくても**フォルダ自体は開ける**（前の起動のぶんが残っている）。
 */
export function logHint(status: LogStatus | null): LogHint {
  if (status === null) return { text: ja.crash.logChecking, canOpen: false };
  if (status.dir === "") return { text: ja.crash.logNowhere, canOpen: false };
  if (!status.writing) {
    return {
      text: ja.crash.logNotWriting(status.problem ?? ja.crash.logUnknownProblem, status.dir),
      canOpen: true,
    };
  }
  return { text: ja.crash.logAt(status.dir), canOpen: true };
}

/** 見出しに使う長さ。これより長い理由は畳んで出す。 */
const HEADLINE_CHARS = 200;

/**
 * 落ちた理由を 1 行にする。
 *
 * **空でも「理由が分かりません」と出す。** 空文字のまま出すと、
 * 何も書かれていない箱が残って壊れて見える。
 */
export function crashSummary(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  if (flat === "") return ja.crash.unknownReason;
  return flat.length <= HEADLINE_CHARS ? flat : `${flat.slice(0, HEADLINE_CHARS)}…`;
}
