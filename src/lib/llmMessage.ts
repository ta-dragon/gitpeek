/**
 * LLM の応答を画面に出すための整形（T-20 の目視で出た要望。2026-09-05）。
 *
 * **純関数だけ。** 整形をコンポーネントへ直書きするとテストが 1 つも当たらない
 * （CLAUDE.md §8）。
 *
 * 直したかったのは 2 つ:
 *
 * - 生の JSON が 1 行のまま狭い欄へ流れ、**とくにエラーのとき原因が読めない**
 * - Rust 側の 1 行に「接続先の言い分」が続くようになり、改行が要る
 */

/** 生の応答をどう出すか。`json` なら整形済み、`text` ならそのまま。 */
export type RawBody = {
  kind: "json" | "text";
  text: string;
  /** 整形後の行数。**折りたたみの既定を決める**のに使う。 */
  lines: number;
};

/** これより短い応答は最初から開いて見せる（開く操作を挟む意味が無い）。 */
export const SHORT_BODY_LINES = 12;

/**
 * 生の応答を読める形にする。
 *
 * **JSON として読めたときだけ整形する。** 読めなければ触らずに返す —
 * HTML のエラーページを JSON のつもりで加工すると、かえって原因が消える。
 *
 * Rust 側が長い応答を切ったとき（末尾に「…（以降は省略）」が付く）は
 * JSON として壊れているので、当然 `text` 側へ落ちる。**それでよい** —
 * 途中で切れたものを整形できたふりをしない。
 */
export function formatRawBody(raw: string): RawBody {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "text", text: "", lines: 0 };

  const parsed = parseJson(trimmed);
  // スカラー（`"abc"` や `123`）を整形しても 1 行のままで、何も良くならない。
  // **入れ物のときだけ**整形する。
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return { kind: "text", text: trimmed, lines: countLines(trimmed) };
  }

  const text = JSON.stringify(parsed, null, 2);
  return { kind: "json", text, lines: countLines(text) };
}

/**
 * 人間向けの 1 行を、表示する行へ分ける。
 *
 * Rust 側は「見出し」と「接続先の言い分」を `\n` で繋いで返す
 * （`llm/client.rs` の `http_error`）。**改行を空白に潰さない** —
 * サーバの言い分がアプリの説明と地続きに見えると、どちらが言っているのか読めない。
 */
export function headlineLines(message: string): string[] {
  return message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function countLines(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}
