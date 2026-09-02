/**
 * スクロールバー上の ref マーカー（docs/DESIGN.md §5.3）。
 *
 * 数万コミットのリストではスクラバが極端に小さくなり、位置感覚が完全に失われる。
 * ブランチ先端をレーン色の短い線、タグを小さな菱形で置いて、
 * 「今どのあたりを見ているか」を取り戻す。ミニマップは作らない。
 */
import { useMemo } from "react";

import { laneColor } from "../../lib/graphPath";
import type { RefEntry } from "../../lib/ipc";

/** 帯を分ける数。これが同時に出るマーカーの上限になる。 */
const BUCKETS = 300;

type Marker = {
  key: string;
  /** 0〜1 の位置。トラックの高さに掛ける。 */
  ratio: number;
  lane: number;
  tag: boolean;
  label: string;
};

export function ScrollbarRefMarkers({
  refs,
  rowIndexBySha,
  laneBySha,
  total,
  onJump,
}: {
  refs: RefEntry[];
  rowIndexBySha: Map<string, number>;
  laneBySha: Map<string, number>;
  total: number;
  onJump: (row: number) => void;
}) {
  const markers = useMemo<Marker[]>(() => {
    if (total === 0) return [];

    // **同じ高さに重なるぶんは 1 本にまとめる。** onyx には ref が 3,790 個あり、
    // そのまま置くと 12px の帯が塗り潰れるうえ DOM が 3,790 要素になる。
    // 束ねる単位は帯の高さではなく固定数（実測せずに済ませるため）。
    const buckets = new Map<number, Marker>();

    for (const entry of refs) {
      if (entry.outOfGraph) continue;
      const row = rowIndexBySha.get(entry.target);
      if (row === undefined) continue;

      const ratio = row / total;
      const bucket = Math.round(ratio * BUCKETS);
      const tag = entry.kind === "tag";
      const existing = buckets.get(bucket);
      // ブランチ先端を優先する。タグより「今どこにいるか」の手掛かりになる。
      if (existing !== undefined && (!existing.tag || tag)) continue;

      buckets.set(bucket, {
        key: entry.name,
        ratio,
        lane: laneBySha.get(entry.target) ?? 0,
        tag,
        label: entry.shortName,
      });
    }
    return [...buckets.values()];
  }, [refs, rowIndexBySha, laneBySha, total]);

  if (markers.length === 0) return null;

  return (
    <div className="refmarks" aria-hidden="true">
      {markers.map((marker) => (
        <button
          type="button"
          key={marker.key}
          className={marker.tag ? "refmarks__tag" : "refmarks__tip"}
          style={{
            top: `${marker.ratio * 100}%`,
            // タグは無彩色寄りにして、ブランチ先端と見分ける。
            background: marker.tag ? "var(--text-faint)" : laneColor(marker.lane),
          }}
          title={marker.label}
          onClick={() => onJump(Math.round(marker.ratio * total))}
        />
      ))}
    </div>
  );
}
