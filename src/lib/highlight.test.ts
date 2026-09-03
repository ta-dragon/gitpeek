import { describe, expect, it } from "vitest";

import type { Segment } from "./diffView";
import { languageOf, mergeHighlight, plainChanged, type Chunk } from "./highlight";

/** `text:changed:color` に潰す（色が無ければ `-`）。 */
function shape(segments: ReturnType<typeof mergeHighlight>): string[] {
  return segments.map((s) => `${s.text}:${s.changed ? "!" : " "}:${s.color ?? "-"}`);
}

function seg(text: string, changed: boolean): Segment {
  return { text, changed };
}

function chunk(text: string, color: string | null): Chunk {
  return { text, color };
}

describe("languageOf", () => {
  it("拡張子から言語を決める", () => {
    expect(languageOf("src/lib/highlight.ts")).toBe("typescript");
    expect(languageOf("src-tauri/src/git/diff.rs")).toBe("rust");
  });

  // Shiki の別名は一部にしか無いので、拡張子をそのまま渡すと落ちる。
  it("別名の無い拡張子も正式名に直す", () => {
    expect(languageOf("a.mts")).toBe("typescript");
    expect(languageOf("a.hpp")).toBe("cpp");
    expect(languageOf("a.yml")).toBe("yaml");
  });

  it("拡張子を持たないファイルは名前で決める", () => {
    expect(languageOf("Dockerfile")).toBe("docker");
    expect(languageOf("build/Makefile")).toBe("make");
  });

  it("知らない拡張子はハイライトしない", () => {
    expect(languageOf("a.unknown")).toBeNull();
    expect(languageOf("README")).toBeNull();
  });

  // 先頭のドットは拡張子ではない。
  it("ドットで始まる名前を拡張子と取り違えない", () => {
    expect(languageOf(".gitignore")).toBeNull();
  });
});

describe("mergeHighlight", () => {
  it("トークンが無ければ語単位差分だけを返す", () => {
    expect(shape(mergeHighlight([seg("abc", true)], undefined))).toEqual(["abc:!:-"]);
    expect(shape(mergeHighlight([seg("abc", true)], []))).toEqual(["abc:!:-"]);
  });

  it("境界が一致するときはそのまま重ねる", () => {
    const merged = mergeHighlight(
      [seg("let ", false), seg("x", true)],
      [chunk("let ", "#f00"), chunk("x", "#0f0")],
    );
    expect(shape(merged)).toEqual(["let : :#f00", "x:!:#0f0"]);
  });

  // 1 つのトークンが変更部分をまたぐ場合。ここで切れないと強調が消える。
  it("トークンが語単位の境界をまたぐなら切り直す", () => {
    const merged = mergeHighlight(
      [seg("ab", false), seg("cd", true)],
      [chunk("abcd", "#f00")],
    );
    expect(shape(merged)).toEqual(["ab: :#f00", "cd:!:#f00"]);
  });

  // 逆向き。1 つの語単位セグメントに複数のトークンが入る場合。
  it("語単位の 1 区切りに複数のトークンが入るなら分ける", () => {
    const merged = mergeHighlight(
      [seg("abcd", true)],
      [chunk("ab", "#f00"), chunk("cd", "#0f0")],
    );
    expect(shape(merged)).toEqual(["ab:!:#f00", "cd:!:#0f0"]);
  });

  it("色の付かないトークンは本文の色のまま", () => {
    const merged = mergeHighlight([seg("ab", false)], [chunk("ab", null)]);
    expect(shape(merged)).toEqual(["ab: :-"]);
  });

  /**
   * 長さが食い違うのは行の切り方を間違えたときだけ。
   * **行がずれるくらいなら色が無いほうがまし**なので、ハイライトを捨てる。
   */
  it("長さが合わなければハイライトを捨てる", () => {
    const merged = mergeHighlight([seg("abcd", true)], [chunk("ab", "#f00")]);
    expect(shape(merged)).toEqual(["abcd:!:-"]);
  });

  it("空行は空のまま", () => {
    expect(mergeHighlight([], [])).toEqual([]);
  });

  // 語単位差分は Array.from（コードポイント単位）で切るので、
  // 合成側が UTF-16 の符号単位で数えていてもずれないことを見る。
  it("サロゲートペアを含んでもずれない", () => {
    const merged = mergeHighlight(
      [seg("𩸽", false), seg("x", true)],
      [chunk("𩸽x", "#f00")],
    );
    expect(shape(merged)).toEqual(["𩸽: :#f00", "x:!:#f00"]);
  });
});

describe("plainChanged", () => {
  it("変わった範囲の構文色を落とす", () => {
    const merged = mergeHighlight([seg("ab", true)], [chunk("ab", "#f00")]);
    expect(shape(plainChanged(merged))).toEqual(["ab:!:-"]);
  });

  it("変わっていない範囲の色は残す", () => {
    const merged = mergeHighlight([seg("ab", false)], [chunk("ab", "#f00")]);
    expect(shape(plainChanged(merged))).toEqual(["ab: :#f00"]);
  });

  // トークンの境目で切られた強調が並ぶと、角丸の継ぎ目が見えてしまう。
  it("同じ見た目になった区切りを 1 つに畳む", () => {
    const merged = mergeHighlight(
      [seg("abcd", true)],
      [chunk("ab", "#f00"), chunk("cd", "#0f0")],
    );
    expect(shape(plainChanged(merged))).toEqual(["abcd:!:-"]);
  });

  it("色が違う未変更どうしは畳まない", () => {
    const merged = mergeHighlight(
      [seg("abcd", false)],
      [chunk("ab", "#f00"), chunk("cd", "#0f0")],
    );
    expect(shape(plainChanged(merged))).toEqual(["ab: :#f00", "cd: :#0f0"]);
  });

  it("変更と未変更は隣り合っても畳まない", () => {
    const merged = mergeHighlight([seg("ab", false), seg("cd", true)], undefined);
    expect(shape(plainChanged(merged))).toEqual(["ab: :-", "cd:!:-"]);
  });

  it("空なら空", () => {
    expect(plainChanged([])).toEqual([]);
  });
});
