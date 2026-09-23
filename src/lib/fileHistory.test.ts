import { describe, expect, it } from "vitest";

import { parseQuery } from "./commitQuery";
import { fileHistoryAction, fileToSelect, historyFileIn } from "./fileHistory";

const change = (path: string, oldPath: string | null = null) => ({ path, oldPath });

describe("fileHistoryAction", () => {
  it("押すと検索欄に path: を入れる。読み戻すと同じパス", () => {
    const action = fileHistoryAction("src/日本語 ファイル.ts", false);
    expect(action.kind).toBe("ready");
    if (action.kind === "ready") {
      expect(parseQuery(action.input).query.path).toBe("src/日本語 ファイル.ts");
    }
  });

  it("未追跡のファイルは押せない（変えたコミットが無い）", () => {
    expect(fileHistoryAction("new.txt", true)).toEqual({ kind: "untracked" });
  });

  it("引用符を含むパスは押せない（書けない）", () => {
    expect(fileHistoryAction('a"b.txt', false)).toEqual({ kind: "unquotable" });
  });
});

describe("historyFileIn", () => {
  const names = ["new.txt", "old.txt"];

  it("改名より後のコミットでは今の名前", () => {
    expect(historyFileIn([change("other.txt"), change("new.txt")], names)).toBe("new.txt");
  });

  it("改名より前のコミットでは昔の名前", () => {
    expect(historyFileIn([change("other.txt"), change("old.txt")], names)).toBe("old.txt");
  });

  it("改名したコミットでは新しい名前の側（差分はそちらで引く）", () => {
    expect(historyFileIn([change("new.txt", "old.txt")], names)).toBe("new.txt");
    // 打った名前が改名元のときも、行は新しい名前で選ぶ。
    expect(historyFileIn([change("renamed.txt", "new.txt")], ["new.txt"])).toBe("renamed.txt");
  });

  it("打った名前を先に見る", () => {
    expect(historyFileIn([change("old.txt"), change("new.txt")], names)).toBe("new.txt");
  });

  it("当たらなければ null", () => {
    expect(historyFileIn([change("other.txt")], names)).toBeNull();
    expect(historyFileIn([], names)).toBeNull();
  });
});

describe("fileToSelect", () => {
  it("ファイルで探していれば、そのコミットでの名前を選ぶ", () => {
    const changes = [change("a.txt"), change("old.txt")];
    expect(fileToSelect(changes, "a.txt", ["new.txt", "old.txt"])).toBe("old.txt");
  });

  it("もう選んでいれば選び直さない", () => {
    expect(fileToSelect([change("new.txt")], "new.txt", ["new.txt"])).toBeNull();
  });

  it("探していなければ、選んでいるものが一覧にある限りそのまま", () => {
    expect(fileToSelect([change("a.txt"), change("b.txt")], "b.txt", [])).toBeNull();
  });

  it("選んでいるものが一覧に無ければ先頭（いままでの振る舞い）", () => {
    expect(fileToSelect([change("a.txt"), change("b.txt")], "gone.txt", [])).toBe("a.txt");
    expect(fileToSelect([change("a.txt")], null, [])).toBe("a.txt");
  });

  it("探しているファイルがそのコミットに無ければ、いままでの振る舞いに戻る", () => {
    expect(fileToSelect([change("a.txt"), change("b.txt")], "b.txt", ["new.txt"])).toBeNull();
    expect(fileToSelect([change("a.txt")], "new.txt", ["new.txt"])).toBe("a.txt");
  });

  it("変更ファイルが無ければ何もしない", () => {
    expect(fileToSelect([], "a.txt", ["a.txt"])).toBeNull();
  });
});
