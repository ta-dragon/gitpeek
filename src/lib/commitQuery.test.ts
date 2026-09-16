import { describe, expect, it } from "vitest";

import { isEmptyQuery, parseQuery, planSearch, wantsCode } from "./commitQuery";

const of = (input: string) => parseQuery(input).query;

describe("parseQuery", () => {
  it("そのまま打ったことばは、メッセージか作者から探すことばになる", () => {
    expect(of("ほげ")).toEqual({ any: "ほげ", message: null, author: null, code: null });
  });

  it("空白を含めて打っても 1 つのことばとして扱う", () => {
    // 2 語に割ると git の実行回数がことばの数だけ増える。
    expect(of("fix typo").any).toBe("fix typo");
  });

  it("指定語は AND の材料として別々に持つ", () => {
    expect(of("message:直す author:tatsuno code:piyo")).toEqual({
      any: null,
      message: "直す",
      author: "tatsuno",
      code: "piyo",
    });
  });

  it("素のことばと指定語は混ぜて打てる", () => {
    const query = of("ほげ author:tatsuno");
    expect(query.any).toBe("ほげ");
    expect(query.author).toBe("tatsuno");
  });

  it("素のことばが離れて書かれても、詰めて 1 つにする", () => {
    expect(of("ほげ author:tatsuno ふが").any).toBe("ほげ ふが");
  });

  it("知らないコロンは素のことばの一部", () => {
    // URL や `fix: typo` が指定語に化けると、打った本人の見込みと違うものを探す。
    expect(of("https://example.com/a").any).toBe("https://example.com/a");
    expect(of("fix:").any).toBe("fix:");
    expect(of("subject:ほげ").any).toBe("subject:ほげ");
  });

  it("引用符で囲めば指定語の値に空白を入れられる", () => {
    expect(of('message:"2 つの語"').message).toBe("2 つの語");
    expect(of('"ほげ ふが"').any).toBe("ほげ ふが");
  });

  it("指定語の大文字小文字は問わない", () => {
    expect(of("Message:ほげ").message).toBe("ほげ");
  });

  it("コロンのあとに続く文字は、コロンを含めてそのまま値になる", () => {
    expect(of("code:a:b").code).toBe("a:b");
  });

  it("値が `-` で始まってもそのまま渡す", () => {
    // フラグとして食われないようにするのは Rust 側の仕事（`--grep=<値>` の形）。
    expect(of("message:--pretty").message).toBe("--pretty");
  });

  it("同じ指定を 2 回書いたら後のほうを使い、そのことを残す", () => {
    const parsed = parseQuery("message:ほげ message:ふが");
    expect(parsed.query.message).toBe("ふが");
    expect(parsed.notices).toEqual([{ kind: "duplicate", key: "message" }]);
  });

  it("同じ指定を 3 回書かれても、言うのは 1 度でよい", () => {
    const parsed = parseQuery("author:a author:b author:c");
    expect(parsed.query.author).toBe("c");
    expect(parsed.notices).toHaveLength(1);
  });

  it("値が空の指定は効かせず、そのことを残す", () => {
    const parsed = parseQuery("message: ほげ");
    expect(parsed.query.message).toBeNull();
    expect(parsed.query.any).toBe("ほげ");
    expect(parsed.notices).toEqual([{ kind: "emptyValue", key: "message" }]);
  });

  it("空欄と空白だけは、何も探していない", () => {
    expect(isEmptyQuery(of(""))).toBe(true);
    expect(isEmptyQuery(of("   "))).toBe(true);
    expect(parseQuery("").notices).toEqual([]);
  });

  it("値の前後の空白は落とす", () => {
    expect(of('message:"  ほげ  "').message).toBe("ほげ");
  });
});

describe("wantsCode", () => {
  it("code: を書いたときだけ真", () => {
    // 素のことばでは走らせない（`git log -S` は 2 万コミットで 17 秒）。
    expect(wantsCode(of("ほげ"))).toBe(false);
    expect(wantsCode(of("code:ほげ"))).toBe(true);
    expect(wantsCode(of("code:"))).toBe(false);
  });
});

describe("planSearch", () => {
  it("空欄なら探さずに戻す", () => {
    expect(planSearch("   ").kind).toBe("clear");
  });

  it("code: が入っていたら、ほかの指定があっても走らせない", () => {
    // 一部だけ探して「当たらなかった」と見せると、code: が効いたように読める。
    expect(planSearch("code:NEEDLE").kind).toBe("refuse");
    expect(planSearch("ほげ code:NEEDLE").kind).toBe("refuse");
  });

  it("メッセージと作者だけなら探す", () => {
    const plan = planSearch("ほげ author:tatsuno");
    expect(plan.kind).toBe("search");
    if (plan.kind === "search") {
      expect(plan.query.any).toBe("ほげ");
      expect(plan.query.author).toBe("tatsuno");
    }
  });

  it("効かなかった打ち方は、探さない場合も残す", () => {
    expect(planSearch("message:").notices).toEqual([{ kind: "emptyValue", key: "message" }]);
    expect(planSearch("message:").kind).toBe("clear");
  });
});
