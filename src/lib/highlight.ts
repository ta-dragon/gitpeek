/**
 * シンタックスハイライト（docs/DESIGN.md §7.2）。
 *
 * Shiki を使う。VS Code と同じ TextMate 文法なので精度が高い代わりに重いので、
 * **文法は言語ごとに動的 import する**。`shiki` のフルバンドルを import すると
 * 全言語の文法が 1 つのチャンクに入ってしまう。
 *
 * **外部 CDN から取らない**（外部通信禁止 — CLAUDE.md §1）。文法も正規表現エンジンの
 * wasm もローカルの import なので、Vite がバンドルに含めて分割する。
 *
 * ここに置くのは「Shiki を呼ぶ」部分と、**トークンと語単位差分を合成する純関数**。
 * 合成のほうはテストで担保する（CLAUDE.md §8「フロントは純関数だけ」）。
 */
import type { HighlighterCore } from "shiki/core";

import type { Segment } from "./diffView";
import type { DiffLine, Hunk } from "./ipc";

/** 行を色で切ったときの一区切り。`color` が null なら本文の色のまま。 */
export type Chunk = { text: string; color: string | null };

/** 語単位差分と色を重ねた結果。描画はこれをそのまま並べるだけ。 */
export type StyledSegment = { text: string; changed: boolean; color: string | null };

export type HighlightTheme = "light" | "dark";

/**
 * Shiki の言語 ID → 文法の読み込み方。
 *
 * **文法は言語ごとに動的 import する。** `shiki` のフルバンドルを import すると
 * 全言語が 1 チャンクに入る。ここに 1 行足せば言語が増える。
 */
const GRAMMARS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  rust: () => import("@shikijs/langs/rust"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  php: () => import("@shikijs/langs/php"),
  lua: () => import("@shikijs/langs/lua"),
  sql: () => import("@shikijs/langs/sql"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  powershell: () => import("@shikijs/langs/powershell"),
  bat: () => import("@shikijs/langs/bat"),
  html: () => import("@shikijs/langs/html"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  xml: () => import("@shikijs/langs/xml"),
  ini: () => import("@shikijs/langs/ini"),
  markdown: () => import("@shikijs/langs/markdown"),
  diff: () => import("@shikijs/langs/diff"),
  docker: () => import("@shikijs/langs/docker"),
  make: () => import("@shikijs/langs/make"),
};

/**
 * 拡張子 → 言語 ID。
 *
 * **Shiki の別名（`ts` など）に頼らない。** 別名があるのは一部だけで、
 * `mts` や `hpp` を渡すと「そんな言語は無い」で落ちる。ここで正式名に直す。
 * **ここに無い拡張子はハイライトしない** — 総当たりで文法を読むより、
 * 素の本文を出すほうが速いし壊れない。
 */
const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  rs: "rust",
  py: "python",
  rb: "ruby",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  lua: "lua",
  sql: "sql",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ps1: "powershell",
  psm1: "powershell",
  bat: "bat",
  cmd: "bat",
  html: "html",
  htm: "html",
  vue: "vue",
  svelte: "svelte",
  css: "css",
  scss: "scss",
  json: "json",
  jsonc: "jsonc",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  svg: "xml",
  ini: "ini",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
  mk: "make",
};

/** 拡張子を持たないが中身の決まっているファイル名。 */
const BY_NAME: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
};

/**
 * パスから Shiki の言語 ID を決める。分からなければ null（＝ハイライトしない）。
 *
 * 拡張子だけで決める。**中身を見て推測しない** — 差分は断片なので当たらないうえ、
 * 外したときに色が壊れるほうが読みにくい。
 */
export function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();

  const byName = BY_NAME[name];
  if (byName !== undefined) return byName;

  const dot = name.lastIndexOf(".");
  // 先頭のドットは拡張子ではない（`.gitignore` に文法は無い）。
  if (dot <= 0) return null;

  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

/**
 * 色と語単位差分を重ねる（純関数）。
 *
 * Shiki の区切りと `wordDiff` の区切りは**互いに無関係**なので、両方の境界で
 * 切り直す。`dangerouslySetInnerHTML` で Shiki の HTML を流し込む手は取らない —
 * 語単位の強調を後から挿せず、片方を諦めることになる。
 *
 * 長さが食い違ったらハイライトを捨てて語単位差分だけ返す。**行がずれるくらいなら
 * 色が無いほうがまし**（食い違うのは行の切り方を間違えたときだけ）。
 */
export function mergeHighlight(
  segments: Segment[],
  chunks: Chunk[] | undefined,
): StyledSegment[] {
  const plain = (): StyledSegment[] =>
    segments.map((segment) => ({ text: segment.text, changed: segment.changed, color: null }));

  if (chunks === undefined || chunks.length === 0) return plain();
  if (total(segments) !== total(chunks)) return plain();

  const merged: StyledSegment[] = [];
  let chunkIndex = 0;
  let chunkOffset = 0;

  for (const segment of segments) {
    let offset = 0;
    while (offset < segment.text.length) {
      const chunk = chunks[chunkIndex];
      const take = Math.min(segment.text.length - offset, chunk.text.length - chunkOffset);
      merged.push({
        text: segment.text.slice(offset, offset + take),
        changed: segment.changed,
        color: chunk.color,
      });

      offset += take;
      chunkOffset += take;
      if (chunkOffset === chunk.text.length) {
        chunkIndex += 1;
        chunkOffset = 0;
      }
    }
  }

  return merged;
}

/**
 * 変わった範囲から構文色を落とし、続きになった区切りを 1 つに畳む（純関数）。
 *
 * **強調の地色の上では構文色が読めない。** 行の地より明るくしてあるので、
 * github-dark の色（#0d1117 前提）を載せると輝度比が 2 を切る。
 * 変わった範囲で知りたいのは「どこが変わったか」なので、色は 1 色でよい。
 *
 * 畳むのは、`mergeHighlight` がトークンの境目で切った結果、**同じ見た目の
 * `<mark>` が並ぶ**ため（角丸の継ぎ目が見える）。
 */
export function plainChanged(segments: StyledSegment[]): StyledSegment[] {
  const result: StyledSegment[] = [];

  for (const segment of segments) {
    const color = segment.changed ? null : segment.color;
    const last = result[result.length - 1];

    if (last !== undefined && last.changed === segment.changed && last.color === color) {
      last.text += segment.text;
      continue;
    }
    result.push({ text: segment.text, changed: segment.changed, color });
  }

  return result;
}

function total(parts: { text: string }[]): number {
  return parts.reduce((sum, part) => sum + part.text.length, 0);
}

/**
 * これより大きい差分はハイライトしない。
 *
 * 折りたたみ（既定 3000 行）を明示的に開いたあとの歯止め。トークン化は同期処理なので、
 * 桁違いの差分を渡すとその間だけ画面が固まる。
 */
export const MAX_HIGHLIGHT_LINES = 20_000;

/**
 * 差分の全行にトークンを割り当てる。**行を鍵にする**（`wordSegments` と同じ）。
 *
 * **片側ずつまとめてトークン化する。** 行を 1 本ずつ渡すと、複数行にまたがる
 * 文字列やコメントが行ごとに切れて色が壊れる。変更前（context + removed）と
 * 変更後（context + added）をそれぞれ 1 本のテキストに戻して渡し、行へ配り直す。
 *
 * 変わっていない行は**変更後の色を採る**（後から書くので上書きになる）。
 * どちらで塗っても同じだが、揃えておかないと再描画のたびに色が揺れる。
 */
export async function highlightDiff(
  hunks: Hunk[],
  language: string,
  theme: HighlightTheme,
): Promise<Map<DiffLine, Chunk[]>> {
  const colors = new Map<DiffLine, Chunk[]>();
  const totalLines = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  if (totalLines > MAX_HIGHLIGHT_LINES) return colors;

  const before: DiffLine[] = [];
  const after: DiffLine[] = [];

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "added") before.push(line);
      if (line.kind !== "removed") after.push(line);
    }
  }

  const highlighter = await load(language);
  for (const side of [before, after]) {
    const tokens = tokenize(highlighter, side, language, theme);
    for (let index = 0; index < side.length; index += 1) {
      const line = tokens[index];
      if (line !== undefined) colors.set(side[index], line);
    }
  }

  return colors;
}

function tokenize(
  highlighter: HighlighterCore,
  lines: DiffLine[],
  language: string,
  theme: HighlightTheme,
): Chunk[][] {
  if (lines.length === 0) return [];

  const result = highlighter.codeToTokens(lines.map((line) => line.text).join("\n"), {
    lang: language,
    theme: themeName(theme),
  });

  // **大文字小文字を揃えて比べる。** トークンは `#24292E`、テーマの既定色は
  // `#24292e` で返ってくるので、そのまま比べると既定色が一致しない。
  const fg = result.fg?.toLowerCase();

  return result.tokens.map((tokens) =>
    tokens.map((token) => ({
      text: token.content,
      // 既定の文字色はテーマトークンに任せる（本文の色と食い違わせない）。
      color:
        token.color === undefined || token.color.toLowerCase() === fg ? null : token.color,
    })),
  );
}

function themeName(theme: HighlightTheme): string {
  return theme === "dark" ? "github-dark" : "github-light";
}

/**
 * ハイライタは 1 つを使い回し、文法だけ後から足す。
 *
 * 生成には wasm の読み込みが要るので、**1 回だけ**にする。
 */
let core: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

async function load(language: string): Promise<HighlighterCore> {
  core ??= createCore();
  const highlighter = await core;

  if (!loaded.has(language)) {
    const grammar = GRAMMARS[language];
    if (grammar !== undefined) await highlighter.loadLanguage((await grammar()) as never);
    loaded.add(language);
  }

  return highlighter;
}

async function createCore(): Promise<HighlighterCore> {
  const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/oniguruma"),
  ]);

  return createHighlighterCore({
    // ライトとダークの 2 つだけ。テーマの背景色は使わず、前景色だけを載せる。
    themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
    langs: [],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
}
