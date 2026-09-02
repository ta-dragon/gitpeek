import { ja } from "../../i18n/ja";

/**
 * 時間のかかる読み込みの途中経過。
 *
 * **総数が分からないことがある**（初回の読み込みでは前回件数が無い）。その場合は
 * 割合を出さず、件数だけを流す。嘘の割合を出すより「進んでいることが分かる」方を採る。
 *
 * fetch（T-17）と clone（T-19）でも同じ形を使えるよう、スナップショットに依存しない
 * 引数にしてある。
 */
export function LoadProgress({
  label,
  done,
  total,
  elapsedMs,
}: {
  label: string;
  done: number;
  /** 概算の総数。分からなければ null（バーは不定表示になる）。 */
  total: number | null;
  elapsedMs: number;
}) {
  // 前回件数を分母にしているので 1 を超えうる。バーは振り切らせない。
  const ratio = total !== null && total > 0 ? Math.min(1, done / total) : null;

  return (
    <div className="progress">
      <div className="progress__head">
        <span className="progress__label">{label}</span>
        <span className="progress__count">
          {total !== null
            ? ja.snapshot.progressOf(done, total)
            : ja.snapshot.progressCount(done)}
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
        {ratio !== null && <span>{ja.snapshot.progressPercent(ratio)}</span>}
        <span className="progress__elapsed">
          {ja.snapshot.progressElapsed(Math.round(elapsedMs / 1000))}
        </span>
      </div>
    </div>
  );
}
