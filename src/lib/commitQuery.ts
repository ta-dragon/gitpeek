/**
 * 検索のことばを解く（T-35。純関数。docs/DESIGN.md §6.6）。
 *
 * 入力欄は 1 つで、打ち方は 2 通りある。
 *
 * - **そのまま打つ** … メッセージ **または** 作者から探す（OR）
 * - **`message:` / `author:` / `code:`** … 埋めた指定どうしは **AND**
 *
 * **コード内容は `code:` を書いたときだけ探す。** 素のことばで走らせない
 * （`git log -S` は 2 万コミットで 17 秒かかる。§6.6 の実測）。
 *
 * ここが返すのは **Rust へ渡す構造体だけ**で、git のフラグは組み立てない
 * （引数を作るのは `src-tauri/src/git/search.rs`。CLAUDE.md §4）。
 */

/** 指定語。**この 3 つだけ。** ほかのコロンは素のことばの一部として扱う。 */
export type QueryKey = "message" | "author" | "code";

/**
 * Rust の `git::search::CommitQuery` と同じ形。**綴りを変えない。**
 *
 * 綴りが違うと serde が食えず、**コマンドが 1 度も走らない**（T-18 で踏んだ）。
 */
export type CommitQuery = {
  /** 指定語なしで打たれたことば。メッセージ または 作者から探す。 */
  any: string | null;
  message: string | null;
  author: string | null;
  code: string | null;
};

/**
 * 打ち方のうち効かなかったところ。**黙って捨てないために返す。**
 *
 * 文言は持たない（`i18n/ja.ts` が引く）。ここが持つのは「何が起きたか」だけ。
 */
export type QueryNotice =
  | { kind: "duplicate"; key: QueryKey }
  | { kind: "emptyValue"; key: QueryKey };

export type ParsedQuery = { query: CommitQuery; notices: QueryNotice[] };

/** 何も打っていない状態。 */
export const EMPTY_QUERY: CommitQuery = {
  any: null,
  message: null,
  author: null,
  code: null,
};

/** `message:` のように書かれたときだけ指定語。`fix:` や `https://…` は当たらない。 */
const NAMED = /^(message|author|code):([\s\S]*)$/i;

/**
 * 空白で割る。ただし `"` で囲んだ中の空白では割らない。**引用符そのものは落とす。**
 *
 * `message:"２つの語"` を 1 つのことばとして渡すための最低限の仕掛けで、
 * エスケープ（`\"`）は持たない。
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;

  for (const character of input) {
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/**
 * 打った文字を、Rust へ渡す形に直す。
 *
 * **素のことばは、指定語を取り除いた残りを詰めて 1 つのことば**にする
 * （`fix typo` は 2 語に割らず「fix typo」を探す）。割ると git の実行回数が
 * ことばの数だけ増えるうえ、打った本人の見込みとも離れる。
 *
 * **同じ指定を 2 回書いたら後のほうを使う。** 黙って捨てると、効いていない指定を
 * 打ったまま「当たらない」と悩むことになるので、`notices` に残して画面へ出す。
 */
export function parseQuery(input: string): ParsedQuery {
  const notices: QueryNotice[] = [];
  const named = new Map<QueryKey, string>();
  const bare: string[] = [];

  const note = (notice: QueryNotice): void => {
    // 同じ指定を 3 回書かれても、言うことは 1 度でよい。
    const already = notices.some(
      (existing) => existing.kind === notice.kind && existing.key === notice.key,
    );
    if (!already) notices.push(notice);
  };

  for (const token of tokenize(input)) {
    const found = NAMED.exec(token);
    if (found === null) {
      bare.push(token);
      continue;
    }

    const key = found[1].toLowerCase() as QueryKey;
    const value = found[2].trim();
    if (value === "") {
      note({ kind: "emptyValue", key });
      continue;
    }
    if (named.has(key)) note({ kind: "duplicate", key });
    named.set(key, value);
  }

  const any = bare.join(" ").trim();
  return {
    query: {
      any: any === "" ? null : any,
      message: named.get("message") ?? null,
      author: named.get("author") ?? null,
      code: named.get("code") ?? null,
    },
    notices,
  };
}

/** 探すことばが 1 つも無いか。**空欄は「まだ何も探していない」**（差分内検索と同じ）。 */
export function isEmptyQuery(query: CommitQuery): boolean {
  return [query.any, query.message, query.author, query.code].every(
    (value) => value === null || value.trim() === "",
  );
}

/**
 * コード内容を探そうとしているか。**重い**（`git log -S` は 2 万コミットで 17 秒）ので、
 * このときだけ完了までの目安を出し、中止ボタンを出す（T-36。docs/DESIGN.md §6.6）。
 */
export function wantsCode(query: CommitQuery): boolean {
  return query.code !== null && query.code.trim() !== "";
}

/**
 * 打ったことばで何をするか。**フックに分岐を書かないために、ここで決める。**
 *
 * - `clear` … 何も打っていない。結果を捨てて「まだ探していない」に戻す
 * - `search` … Rust へ渡して探す。`slow` はコード内容を含むとき（目安と中止を出す）
 *
 * どちらの場合も `notices`（効かなかった打ち方）は画面へ出す。
 */
export type SearchPlan =
  | { kind: "clear"; notices: QueryNotice[] }
  | { kind: "search"; query: CommitQuery; slow: boolean; notices: QueryNotice[] };

export function planSearch(input: string): SearchPlan {
  const { query, notices } = parseQuery(input);
  if (isEmptyQuery(query)) return { kind: "clear", notices };
  return { kind: "search", query, slow: wantsCode(query), notices };
}
