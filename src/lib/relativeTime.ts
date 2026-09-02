/**
 * 日時の表示（docs/DESIGN.md §6.3）。**純関数だけを置く**（§14.4）。
 *
 * 既定は相対表示で、ホバーで絶対を出す。入れ替えは `settings.json` の `ui.dateFormat`。
 * `Intl.RelativeTimeFormat` は使わない。「3 日前」の 1 形だけで足りるうえ、
 * 単位の切り替わりを自分で決められないため。
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 「N か月前」に切り替える境目。暦月ではなく 30 日固定で扱う。 */
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Unix 秒を相対表示にする。`now` はミリ秒（テストから固定するため引数にしている）。
 *
 * **未来の日時も扱う。** 時計のずれた環境で作られたコミットや、rebase 後の
 * author 日時が未来を指すことがある。負の差を切り捨てて「たった今」にすると、
 * 明らかに変な日時が黙って隠れてしまう。
 */
export function relativeTime(unixSeconds: number, now: number = Date.now()): string {
  const diff = Math.floor(now / 1000) - Math.floor(unixSeconds);
  const ahead = diff < 0;
  const seconds = Math.abs(diff);

  if (seconds < MINUTE) return "たった今";

  const [value, unit] = scale(seconds);
  return ahead ? `${value} ${unit}後` : `${value} ${unit}前`;
}

function scale(seconds: number): [number, string] {
  if (seconds < HOUR) return [Math.floor(seconds / MINUTE), "分"];
  if (seconds < DAY) return [Math.floor(seconds / HOUR), "時間"];
  if (seconds < MONTH) return [Math.floor(seconds / DAY), "日"];
  if (seconds < YEAR) return [Math.floor(seconds / MONTH), "か月"];
  return [Math.floor(seconds / YEAR), "年"];
}

/**
 * Unix 秒を絶対表示にする。ローカル時刻で `2026-09-03 06:12`。
 *
 * ISO 8601 のままにしないのは、秒とタイムゾーンが並ぶと日時の比較がしづらいため。
 * ツールチップには [`absoluteTimeDetailed`] の方を使う。
 */
export function absoluteTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** ツールチップ用。秒まで出す。 */
export function absoluteTimeDetailed(unixSeconds: number): string {
  return `${absoluteTime(unixSeconds)}:${pad(new Date(unixSeconds * 1000).getSeconds())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
