/**
 * 画像差分（T-46。docs/DESIGN.md §7.2.1）。**変更前と変更後を左右に並べるだけ**（重ね合わせは無い）。
 *
 * バイナリと分かったファイルで両側を読み、**どちらも画像でなければ `fallback`**（いまどおりのサイズの
 * 表示）を出す。どれを出すか・何と書くかは純関数（`lib/imageDiff.ts`）。
 *
 * 原寸で出し、枠に収まらないときだけ縮める（拡大はしない）。透明な部分は市松模様の上に出す。
 */
import { useEffect, useState, type ReactNode } from "react";

import { ja } from "../../i18n/ja";
import { loadImageSide, type DiffSource, type ImageSideName } from "../../lib/ipc";
import {
  parseImageResponse,
  showsImagePair,
  sideMessage,
  sideMeta,
  type ImageSide,
} from "../../lib/imageDiff";

type Loaded = { old: ImageSide; new: ImageSide };

const ABSENT: ImageSide = { head: { kind: "absent" }, bytes: new Uint8Array() };

export function ImageDiff({
  repositoryId,
  source,
  path,
  oldPath,
  untracked = false,
  fallback,
}: {
  repositoryId: string;
  source: DiffSource;
  path: string;
  oldPath: string | null;
  /** 未追跡のファイル。**変更前は聞くまでもなく無い**ので、git を呼ばない。 */
  untracked?: boolean;
  /** どちらも画像でなかったとき（と、読めなかったとき）に出すもの。 */
  fallback: ReactNode;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceKey = JSON.stringify(source);

  useEffect(() => {
    let current = true;
    setLoaded(null);
    setError(null);

    const read = (side: ImageSideName) =>
      loadImageSide({ repositoryId, source, path, oldPath, side }).then(parseImageResponse);

    void Promise.all([untracked ? Promise.resolve(ABSENT) : read("old"), read("new")])
      .then(([old, neu]) => {
        if (current) setLoaded({ old, new: neu });
      })
      .catch((caught: unknown) => {
        if (current) setError(typeof caught === "string" ? caught : String(caught));
      });

    return () => {
      current = false;
    };
    // `source` は呼び出しのたびに作り直されるので、素の値（JSON）で比べる。
  }, [repositoryId, sourceKey, path, oldPath, untracked]);

  if (error !== null) {
    return (
      <>
        {fallback}
        <div className="dpane__notice">
          <p className="dpane__error">{ja.diff.imageFailed}</p>
          <p className="dpane__detail">{error}</p>
        </div>
      </>
    );
  }
  if (loaded === null) return <p className="dpane__pending">{ja.diff.loading}</p>;
  if (!showsImagePair(loaded.old.head, loaded.new.head)) return <>{fallback}</>;

  return (
    <div className="imgdiff">
      <ImageColumn label={ja.diff.imageBefore} side={loaded.old} />
      <ImageColumn label={ja.diff.imageAfter} side={loaded.new} />
    </div>
  );
}

function ImageColumn({ label, side }: { label: string; side: ImageSide }) {
  const [url, setUrl] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [broken, setBroken] = useState(false);

  // **Blob の URL は作ったら必ず捨てる**（ファイルを移るたびに画像がメモリに残り続ける）。
  useEffect(() => {
    setDimensions(null);
    setBroken(false);
    if (side.head.kind !== "image") {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(new Blob([side.bytes], { type: side.head.mime }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [side]);

  const message = broken ? ja.diff.imageBroken : sideMessage(side.head);
  const meta = sideMeta(side.head, dimensions);

  return (
    <figure className="imgdiff__side">
      <figcaption className="imgdiff__label">{label}</figcaption>
      <div className={`imgdiff__frame${message === null ? " imgdiff__frame--image" : ""}`}>
        {message === null && url !== null ? (
          <img
            className="imgdiff__img"
            src={url}
            alt={label}
            onLoad={(event) =>
              setDimensions({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setBroken(true)}
          />
        ) : (
          <p className="imgdiff__message">{message}</p>
        )}
      </div>
      {meta !== null && <p className="imgdiff__meta">{meta}</p>}
    </figure>
  );
}
