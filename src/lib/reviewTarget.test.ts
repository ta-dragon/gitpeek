import { describe, expect, it } from "vitest";

import type { DiffSource } from "./ipc";
import {
  commitLabel,
  describeTarget,
  selectionForSource,
  shortSha,
  trimSubject,
  NO_CONTEXT,
  type TargetContext,
} from "./reviewTarget";

/** 読み込んだコミットから要約を引ける文脈。 */
function withSubjects(subjects: Record<string, string>): TargetContext {
  return {
    repositoryName: "givsoner",
    subjectOf: (sha) => (sha in subjects ? subjects[sha] : null),
  };
}

const RANGE: DiffSource = {
  kind: "range",
  parent: "aaaaaaaaaa11",
  sha: "bbbbbbbbbb22",
  symmetric: false,
};

describe("shortSha", () => {
  it("8 桁に切る", () => {
    expect(shortSha("bbbbbbbbbb22")).toBe("bbbbbbbb");
  });

  // 端の値: 8 桁より短い入力。**切り詰めずそのまま。**
  it("短い SHA はそのまま返す", () => {
    expect(shortSha("abc")).toBe("abc");
    expect(shortSha("")).toBe("");
  });
});

describe("trimSubject", () => {
  it("そのままの長さなら触らない", () => {
    expect(trimSubject("fix: 直す")).toBe("fix: 直す");
  });

  // 端の値: ちょうど 40 文字と 41 文字。
  it("40 文字までは切らず、41 文字から切る", () => {
    const just = "あ".repeat(40);
    expect(trimSubject(just)).toBe(just);

    const over = "あ".repeat(41);
    expect(trimSubject(over)).toBe(`${"あ".repeat(40)}…`);
  });

  // **改行入りの要約が来ても 1 行に収める**（履歴には手で置かれたファイルも来る）。
  it("改行と連続する空白を 1 つの空白に潰す", () => {
    expect(trimSubject("前\n\n後  ろ")).toBe("前 後 ろ");
  });

  // 端の値: 空文字と空白だけ。
  it("空文字と空白だけは空文字にする", () => {
    expect(trimSubject("")).toBe("");
    expect(trimSubject("   \n ")).toBe("");
  });
});

describe("commitLabel", () => {
  it("要約が引けたら添える", () => {
    const label = commitLabel("bbbbbbbbbb22", withSubjects({ bbbbbbbbbb22: "fix: 直す" }));
    expect(label).toBe("bbbbbbbb「fix: 直す」");
  });

  // **引けないときは SHA だけ。** 読み込んだ集合の外にあるコミットで起きる。
  it("要約が引けなければ SHA だけにする", () => {
    expect(commitLabel("bbbbbbbbbb22", NO_CONTEXT)).toBe("bbbbbbbb");
  });

  // 端の値: メッセージが空のコミット。**「引けなかった」と区別が付くこと。**
  it("メッセージが空のコミットはそう書く", () => {
    const label = commitLabel("bbbbbbbbbb22", withSubjects({ bbbbbbbbbb22: "" }));
    expect(label).toBe("bbbbbbbb「（メッセージなし）」");
    expect(label).not.toBe(commitLabel("bbbbbbbbbb22", NO_CONTEXT));
  });
});

describe("describeTarget", () => {
  it("コミットと親の差分は、比べた先の要約を添える", () => {
    const text = describeTarget(RANGE, withSubjects({ bbbbbbbbbb22: "fix: 直す" }));
    expect(text).toContain("aaaaaaaa");
    expect(text).toContain("bbbbbbbb「fix: 直す」");
    // **親のほうには要約を付けない**（1 行に収まらず、どちらの要約か読めなくなる）。
    expect(text).not.toContain("aaaaaaaa「");
  });

  it("要約が引けなくても SHA で読める", () => {
    const text = describeTarget(RANGE, NO_CONTEXT);
    expect(text).toBe("aaaaaaaa から bbbbbbbb への変更");
  });

  it("分かれたところからの比較を言い分ける", () => {
    const text = describeTarget({ ...RANGE, symmetric: true }, NO_CONTEXT);
    expect(text).toContain("分かれたところ");
  });

  it("最初のコミットは片側だけ書く", () => {
    const text = describeTarget(
      { kind: "range", parent: null, sha: "bbbbbbbbbb22", symmetric: false },
      withSubjects({ bbbbbbbbbb22: "最初" }),
    );
    expect(text).toBe("最初のコミット bbbbbbbb「最初」");
  });

  // **git の用語をそのまま出さない**（CLAUDE.md §6）。
  it("作業ツリーは何の変更かで書く", () => {
    expect(describeTarget({ kind: "workingTree", staged: true }, NO_CONTEXT)).toBe(
      "コミット予定の変更（ステージ済み）",
    );
    expect(describeTarget({ kind: "workingTree", staged: false }, NO_CONTEXT)).toBe(
      "まだコミットしていない変更",
    );
  });

  // 端の値: 記録に何も残っていない履歴（壊れた 1 件・古い形式）。**行を消さない。**
  it("記録が無いときも文言を返す", () => {
    expect(describeTarget(null, NO_CONTEXT)).toBe(
      "何をレビューしたのか、この記録には残っていません。",
    );
  });
});

describe("selectionForSource", () => {
  /** `bbbbbbbbbb22` の第一親は `aaaaaaaaaa11`。それ以外は読み込んでいない。 */
  const firstParentOf = (sha: string) => (sha === "bbbbbbbbbb22" ? "aaaaaaaaaa11" : null);

  // **親と比べただけなら 1 点選択に戻す**（比較の見た目を残さない）。
  it("コミットとその親は 1 点の選択にする", () => {
    expect(selectionForSource(RANGE, firstParentOf)).toEqual({
      kind: "commits",
      selectedCommit: "bbbbbbbbbb22",
      compareCommit: null,
      symmetric: false,
    });
  });

  it("親ではない 2 点は比較として復元する", () => {
    const source = { ...RANGE, parent: "cccccccccc33" };
    expect(selectionForSource(source, firstParentOf)).toEqual({
      kind: "commits",
      selectedCommit: "bbbbbbbbbb22",
      compareCommit: "cccccccccc33",
      symmetric: false,
    });
  });

  // **マージベース起点の比較は、その旨も復元する**（差分の中身が変わるため）。
  it("分かれたところからの比較を復元する", () => {
    expect(selectionForSource({ ...RANGE, symmetric: true }, firstParentOf)).toEqual({
      kind: "commits",
      selectedCommit: "bbbbbbbbbb22",
      compareCommit: "aaaaaaaaaa11",
      symmetric: true,
    });
  });

  it("最初のコミットは 1 点の選択にする", () => {
    expect(
      selectionForSource(
        { kind: "range", parent: null, sha: "bbbbbbbbbb22", symmetric: false },
        firstParentOf,
      ),
    ).toEqual({
      kind: "commits",
      selectedCommit: "bbbbbbbbbb22",
      compareCommit: null,
      symmetric: false,
    });
  });

  it("作業ツリーはそのまま", () => {
    expect(selectionForSource({ kind: "workingTree", staged: true }, firstParentOf)).toEqual({
      kind: "workingTree",
    });
  });

  // 端の値: 記録が無い。**いま見ているものを動かさない。**
  it("記録が無ければ何もしない", () => {
    expect(selectionForSource(null, firstParentOf)).toBeNull();
  });

  // **読み込んでいないコミットは第一親を引けない** → 比較として復元する（差分は同じ）。
  it("読み込んでいないコミットは比較として復元する", () => {
    expect(selectionForSource(RANGE, () => null)).toEqual({
      kind: "commits",
      selectedCommit: "bbbbbbbbbb22",
      compareCommit: "aaaaaaaaaa11",
      symmetric: false,
    });
  });
});
