import { describe, expect, it } from "vitest";

import { formatRawBody, headlineLines, SHORT_BODY_LINES } from "./llmMessage";

describe("formatRawBody", () => {
  it("JSON は読める形に整える", () => {
    const raw = `{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}`;
    const body = formatRawBody(raw);

    expect(body.kind).toBe("json");
    expect(body.text).toBe(
      [
        "{",
        '  "error": {',
        '    "message": "Incorrect API key provided",',
        '    "type": "invalid_request_error"',
        "  }",
        "}",
      ].join("\n"),
    );
    expect(body.lines).toBe(6);
  });

  it("配列も整える", () => {
    expect(formatRawBody(`[{"id":"a"},{"id":"b"}]`).kind).toBe("json");
  });

  /** **HTML のエラーページを JSON のつもりで加工しない。** */
  it("JSON でなければ触らない", () => {
    const raw = "<html><body><h1>502 Bad Gateway</h1></body></html>";
    expect(formatRawBody(raw)).toEqual({ kind: "text", text: raw, lines: 1 });
  });

  /** スカラーを整形しても 1 行のままで、何も良くならない。 */
  it("スカラーは整形しない", () => {
    expect(formatRawBody(`"just a string"`).kind).toBe("text");
    expect(formatRawBody("123").kind).toBe("text");
    expect(formatRawBody("null").kind).toBe("text");
  });

  it("空なら空のまま", () => {
    expect(formatRawBody("")).toEqual({ kind: "text", text: "", lines: 0 });
    expect(formatRawBody("   \n  ")).toEqual({ kind: "text", text: "", lines: 0 });
  });

  /**
   * Rust 側が切った応答は JSON として壊れている。
   * **整形できたふりをしない**（途中で切れたことが見えるほうがよい）。
   */
  it("途中で切れた JSON は text のまま", () => {
    const cut = `{"choices":[{"message":{"content":"あああ…（以降は省略）`;
    const body = formatRawBody(cut);
    expect(body.kind).toBe("text");
    expect(body.text).toContain("以降は省略");
  });

  it("行数を数えて折りたたみの判断に使えるようにする", () => {
    const many = JSON.stringify(
      Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])),
    );
    expect(formatRawBody(many).lines).toBeGreaterThan(SHORT_BODY_LINES);
    expect(formatRawBody(`{"a":1}`).lines).toBeLessThanOrEqual(SHORT_BODY_LINES);
  });
});

describe("headlineLines", () => {
  /** Rust 側は見出しと「接続先の言い分」を `\n` で繋いで返す。 */
  it("見出しとサーバの言い分を分ける", () => {
    expect(
      headlineLines(
        "API キーが受け付けられませんでした（HTTP 401）。\n接続先の言い分: Incorrect API key provided",
      ),
    ).toEqual([
      "API キーが受け付けられませんでした（HTTP 401）。",
      "接続先の言い分: Incorrect API key provided",
    ]);
  });

  it("1 行だけならそのまま 1 件", () => {
    expect(headlineLines("接続できませんでした。")).toEqual(["接続できませんでした。"]);
  });

  it("空行は落とす", () => {
    expect(headlineLines("あ\n\n  \nい")).toEqual(["あ", "い"]);
    expect(headlineLines("")).toEqual([]);
  });
});
