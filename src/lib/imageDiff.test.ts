import { describe, expect, it } from "vitest";

import { ja } from "../i18n/ja";
import {
  parseImageResponse,
  showsImagePair,
  sideMessage,
  sideMeta,
  type ImageHead,
} from "./imageDiff";

// 文言そのものは assert しない（CLAUDE.md §8）。見るのは分け方と、どの場合に何を出すか。

function response(head: string, bytes: number[]): ArrayBuffer {
  const headBytes = new TextEncoder().encode(head);
  const all = new Uint8Array(headBytes.length + 1 + bytes.length);
  all.set(headBytes, 0);
  all[headBytes.length] = 10;
  all.set(bytes, headBytes.length + 1);
  return all.buffer;
}

const image: ImageHead = { kind: "image", mime: "image/png", size: 2048 };
const absent: ImageHead = { kind: "absent" };
const notImage: ImageHead = { kind: "notImage", size: 10 };
const tooLarge: ImageHead = { kind: "tooLarge", size: 20 * 1024 * 1024 };

describe("parseImageResponse", () => {
  it("最初の改行で見出しと中身を分ける（中身に改行があっても崩れない）", () => {
    const side = parseImageResponse(
      response('{"kind":"image","mime":"image/png","size":3}', [10, 0, 255]),
    );
    expect(side.head).toEqual({ kind: "image", mime: "image/png", size: 3 });
    expect(Array.from(side.bytes)).toEqual([10, 0, 255]);
  });

  it("中身の無い見出しも読める", () => {
    const side = parseImageResponse(response('{"kind":"tooLarge","size":99}', []));
    expect(side.head).toEqual({ kind: "tooLarge", size: 99 });
    expect(side.bytes.length).toBe(0);
  });

  // 黙って「無い」にすると、読めなかったのか無いのか分からなくなる。
  it("形が崩れていたら投げる", () => {
    expect(() => parseImageResponse(new TextEncoder().encode("見出しなし").buffer)).toThrow();
    expect(() => parseImageResponse(response('{"kind":"なにか"}', []))).toThrow();
    expect(() => parseImageResponse(response("null", []))).toThrow();
  });
});

describe("showsImagePair", () => {
  it("どちらかが画像なら並べる（追加・削除も）", () => {
    expect(showsImagePair(image, image)).toBe(true);
    expect(showsImagePair(absent, image)).toBe(true);
    expect(showsImagePair(image, absent)).toBe(true);
    expect(showsImagePair(image, notImage)).toBe(true);
  });

  it("どちらも画像でなければ並べず、いまどおりサイズだけ出す", () => {
    expect(showsImagePair(notImage, notImage)).toBe(false);
    expect(showsImagePair(absent, notImage)).toBe(false);
    expect(showsImagePair(absent, absent)).toBe(false);
  });

  it("大きくて読まなかったものは、読まなかったことを伝えるために並べる", () => {
    expect(showsImagePair(tooLarge, notImage)).toBe(true);
  });
});

describe("sideMessage / sideMeta", () => {
  it("画像なら絵を出す（一文は出さない）", () => {
    expect(sideMessage(image)).toBeNull();
  });

  it("画像でない側は、それぞれ違う一文で理由を出す", () => {
    const messages = [absent, notImage, tooLarge].map(sideMessage);
    expect(messages.every((message) => message !== null)).toBe(true);
    expect(new Set(messages).size).toBe(3);
  });

  it("大きすぎるものは大きさを添える", () => {
    expect(sideMessage(tooLarge)).toContain("20");
  });

  it("縦横は読み込んでから添え、それまではバイト数だけ", () => {
    const before = sideMeta(image, null);
    const after = sideMeta(image, { width: 640, height: 480 });
    expect(before).not.toBeNull();
    expect(after).toContain("640");
    expect(after).toContain("480");
    expect(after).not.toBe(before);
  });

  it("無い側には何も添えない", () => {
    expect(sideMeta(absent, null)).toBeNull();
    expect(sideMeta(notImage, null)).not.toBeNull();
  });

  it("「なし」はサイズの「なし」と同じ言い方にする（同じ画面に並ぶ）", () => {
    expect(sideMessage(absent)).toBe(ja.diff.sizeUnknown);
  });
});
