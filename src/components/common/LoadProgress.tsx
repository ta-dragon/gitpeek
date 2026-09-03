import { ja } from "../../i18n/ja";

/**
 * 時間のかかる読み込みの途中経過。
 *
 * **総数が分からないことがある**（初回の読み込みでは前回件数が無い）。その場合は
 * 割合を出さず、件数だけを流す。嘘の割合を出すより「進んでいることが分かる」方を採る。
 *
 * **総数が「概算」か「正確」かは呼び出し側が言う。** 履歴の読み込みは前回件数を
 * 分母にしているので「約」が要るが、fetch のオブジェクト数は git が数えた正確な値なので、
 * 「約」を付けると逆に嘘になる。
 *
 * fetch（T-17）と clone（T-19）でも同じ形を使えるよう、スナップショットに依存しない
 * 引数にしてある。
 */
export function LoadProgress({
  label,
  done,
  total,
  elapsedMs,
  estimated = true,
}: {
  label: string;
  done: number;
  /** 総数。分からなければ null（バーは不定表示になる）。 */
  total: number | null;
  /** 経過時間。出す意味が無い場面（件数だけのバー）は null。 */
  elapsedMs: number | null;
  /** 総数が概算か。**既定は概算**（履歴の読み込みがそうであるため）。 */
  estimated?: boolean;
}) {
  // 前回件数を分母にしているので 1 を超えうる。バーは振り切らせない。
  const ratio = total !== null && total > 0 ? Math.min(1, done / total) : null;

  return (
    <div className="progress">
      <div className="progress__head">
        <span className="progress__label">{label}</span>
        <span className="progress__count">
          {total === null
            ? ja.snapshot.progressCount(done)
            : estimated
              ? ja.snapshot.progressOf(done, total)
              : ja.snapshot.progressExactOf(done, total)}
        </span>
      </div>

      <div
        className={`progress__track${ratio === null ? " progress__track--unknown" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={ratio === null ? undefined : 100}
        aria-valuenow={ratio === null ? undefined : Math.round(ratio * 100)}
        aria-label={label}
      >
        {ratio !== null && (
          <div className="progress__bar" style={{ width: `${ratio * 100}%` }} />
        )}
      </div>

      <div className="progress__foot">
        {ratio !== null && (
          <span>
            {estimated
              ? ja.snapshot.progressPercent(ratio)
              : ja.snapshot.progressExactPercent(ratio)}
          </span>
        )}
        {elapsedMs !== null && (
          <span className="progress__elapsed">
            {ja.snapshot.progressElapsed(Math.round(elapsedMs / 1000))}
          </span>
        )}
      </div>
    </div>
  );
}
