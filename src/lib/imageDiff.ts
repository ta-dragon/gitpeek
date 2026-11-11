/**
 * 画像差分（T-46。docs/DESIGN.md §7.2.1。純関数）。
 *
 * Rust（`src-tauri/src/git/image.rs`）は片側ずつ **JSON の見出し 1 行 ＋ 改行 ＋ 生のバイト列**で返す。
 * ここは、それを分けることと、**左右に並べるのか・いまどおりサイズだけ出すのか**、各側に何と書くかを決める。
 */
import { ja } from "../i18n/ja";
import { formatBytes } from "./diffRows";

/** Rust の `ImageHead` と同じ形。 */
export type ImageHead =
  | { kind: "absent" }
  | { kind: "tooLarge"; size: number }
  | { kind: "notImage"; size: number }
  | { kind: "image"; mime: string; size: number };

export type ImageSide = {
  head: ImageHead;
  /** `image` のときだけ中身がある。 */
  bytes: Uint8Array;
};

const NEWLINE = 10;

/**
 * 見出しと中身を分ける。**最初の改行が区切り**（見出しの JSON に生の改行は入らない）。
 * 形が崩れていたら投げる — 黙って「無い」にすると、読めなかったのか無いのか分からなくなる。
 */
export function parseImageResponse(buffer: ArrayBuffer): ImageSide {
  const all = new Uint8Array(buffer);
  const split = all.indexOf(NEWLINE);
  if (split < 0) throw new Error("画像の応答に見出しがありません");
  const head = JSON.parse(new TextDecoder().decode(all.subarray(0, split))) as ImageHead;
  if (!isHead(head)) throw new Error("画像の応答の見出しを読めません");
  return { head, bytes: all.subarray(split + 1) };
}

function isHead(value: unknown): value is ImageHead {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "absent" || kind === "tooLarge" || kind === "notImage" || kind === "image";
}

/**
 * 左右に並べるか。**どちらの側も画像でない（無い・画像ではない）なら並べない** — いまどおり
 * 「バイナリなので差分は出せません」とサイズの変化を出す（画像でないバイナリに空の枠を 2 つ出さない）。
 * 上限を超えたものは画像かどうか分からないが、**大きいから読まなかった**ことは伝える。
 */
export function showsImagePair(old: ImageHead, neu: ImageHead): boolean {
  const worth = (head: ImageHead) => head.kind === "image" || head.kind === "tooLarge";
  return worth(old) || worth(neu);
}

/** 画像の代わりに出す一文。画像のときは null（絵を出す）。 */
export function sideMessage(head: ImageHead): string | null {
  switch (head.kind) {
    case "absent":
      return ja.diff.imageAbsent;
    case "tooLarge":
      return ja.diff.imageTooLarge(formatBytes(head.size));
    case "notImage":
      return ja.diff.imageNotImage;
    case "image":
      return null;
  }
}

/**
 * 絵の下に添える一行。**縦横は読み込んでから分かる**ので、それまではバイト数だけ。
 * 無い側には何も添えない（「なし」は枠の中に出ている）。
 */
export function sideMeta(
  head: ImageHead,
  dimensions: { width: number; height: number } | null,
): string | null {
  if (head.kind === "absent") return null;
  const size = formatBytes(head.size);
  if (head.kind === "image" && dimensions !== null) {
    return ja.diff.imageMeta(dimensions.width, dimensions.height, size);
  }
  return size;
}
