/**
 * 設定画面の入力検証（T-25。純関数）。
 *
 * **判定をコンポーネントに直書きしない**（CLAUDE.md §8）。フロントは純関数だけ
 * テストする決まりなので、`.tsx` に書いた条件は誰も見ていない。
 *
 * **`settings.json` は手編集を想定している**（CLAUDE.md §5）ので、画面で締めるだけでは
 * 足りない。**同じ範囲を Rust の `Settings::normalize()` にも置き**、
 * どちらか一方だけ直せない形にしてある（範囲を変えたら**両方**直すこと。
 * `src-tauri/src/store/settings.rs` のテストが同じ数を見ている）。
 */
import { ja } from "../i18n/ja";
import { ALL_CONTEXT_LINES } from "./ipc";

/** 数値の欄。**最小・最大・既定をここだけに書く。** */
export type NumberField = {
  min: number;
  max: number;
  fallback: number;
};

/**
 * 数値の欄の範囲。
 *
 * **Rust の `normalize()` と同じ値**であること（片方だけ変えない）。
 */
export const NUMBER_FIELDS = {
  /** 差分に出す前後の行。**「すべて」は十分大きな `-U` で代用している。** */
  contextLines: { min: 0, max: ALL_CONTEXT_LINES, fallback: 3 },
  /** これより多い行の差分は既定で畳む。 */
  collapseLines: { min: 100, max: 1_000_000, fallback: 3_000 },
  /** 同じくバイト数。 */
  collapseBytes: { min: 10_000, max: 100_000_000, fallback: 512_000 },
  /** fetch の放置警告。**0 は「警告しない」**（範囲外ではない）。 */
  staleWarningDays: { min: 0, max: 365, fallback: 7 },
  /** レビューの並列度。上限 3（CLAUDE.md §7）。 */
  reviewConcurrency: { min: 1, max: 3, fallback: 1 },
  /** LLM へ渡す unified diff の文脈行。 */
  reviewContextLines: { min: 0, max: 50, fallback: 10 },
} satisfies Record<string, NumberField>;

export type NumberFieldName = keyof typeof NUMBER_FIELDS;

/**
 * 入力の判定結果。
 *
 * **理由が付くときも欄は消さない**（CLAUDE.md §6）。値が返らないときは
 * 保存しないだけで、打った文字はそのまま残す。
 */
export type FieldResult = { value: number; reason: null } | { value: null; reason: string };

/**
 * 数値の欄を読む。
 *
 * **空欄は「消した」ではなく「まだ入っていない」**として扱い、理由を出して
 * 保存しない（0 を意味しない — `staleWarningDays` では 0 に意味がある）。
 * 小数と符号付きも弾く（設定の数値はすべて 0 以上の整数）。
 */
export function readNumber(name: NumberFieldName, input: string): FieldResult {
  const field = NUMBER_FIELDS[name];
  const text = input.trim();

  if (text === "") return { value: null, reason: ja.settings.form.empty };
  if (!/^\d+$/.test(text)) return { value: null, reason: ja.settings.form.notANumber };

  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    return { value: null, reason: ja.settings.form.outOfRange(field.min, field.max) };
  }
  if (value < field.min || value > field.max) {
    return { value: null, reason: ja.settings.form.outOfRange(field.min, field.max) };
  }
  return { value, reason: null };
}

/**
 * 保存済みの値を欄に出す形にする。
 *
 * **範囲外の値が入っていても書き換えない。** 手で書いた値を画面が黙って
 * 直すと、直したことに気付けない（Rust 側の `normalize()` が読み込みのときに
 * 締めるので、ここでやるのは表示だけ）。
 */
export function showNumber(value: number): string {
  return String(value);
}

/** 選択肢の欄。**候補に無い値が入っていたら既定を選ぶ**（Rust と同じ）。 */
export function readChoice<T extends string>(value: string, allowed: readonly T[]): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : allowed[0];
}
