import { describe, expect, it } from "vitest";

import type { Finding, ReviewFileResult, StoredReview } from "./ipc";
import { markdownFileName, toMarkdown } from "./reviewMarkdown";
import { NO_CONTEXT, type TargetContext } from "./reviewTarget";

/** 書き出しの文脈。**リポジトリ名と要約が引ける場合**。 */
const CONTEXT: TargetContext = {
  repositoryName: "givsoner",
  subjectOf: (sha) => (sha === "bbbbbbbbbb" ? "fix: 直す" : null),
};

function finding(extra: Partial<Finding> = {}): Finding {
  return {
    file: "a.ts",
    line: 12,
    severity: "major",
    title: "見出し",
    message: "本文",
    ...extra,
  };
}

function file(extra: Partial<ReviewFileResult> = {}): ReviewFileResult {
  return {
    path: "a.ts",
    oldPath: null,
    parts: 1,
    text: { summary: "要約", findings: [finding()], markdown: null, fallbackReason: null },
    error: null,
    tokensEstimate: 10,
    elapsedMs: 5,
    ...extra,
  };
}

function stored(extra: Partial<StoredReview["run"]> = {}): StoredReview {
  return {
    schemaVersion: 1,
    repositoryId: "r1",
    savedAt: "2026-09-06T12:04:31+09:00",
    file: "20260906T120431-1a2b3c4d.json",
    profile: { name: "ローカル", model: "qwen2.5-coder:14b", baseUrl: "http://localhost:11434/v1" },
    run: {
      runId: "1a2b3c4d",
      profileId: "p1",
      model: "qwen2.5-coder:14b",
      source: { kind: "range", parent: "aaaaaaaaaa", sha: "bbbbbbbbbb", symmetric: false },
      skills: [{ name: "general-review", origin: "builtIn" }],
      files: [file()],
      summary: { summary: "全体の要約", findings: [], markdown: null, fallbackReason: null },
      failed: 0,
      cancelled: false,
      startedAt: 0,
      elapsedMs: 100,
      ...extra,
    },
  };
}

describe("toMarkdown", () => {
  it("見出し・メタ情報・指摘を出す", () => {
    const text = toMarkdown(stored(), CONTEXT);
    expect(text).toContain("# AI レビュー結果");
    expect(text).toContain("qwen2.5-coder:14b");
    expect(text).toContain("2026-09-06T12:04:31+09:00");
    expect(text).toContain("## a.ts");
    expect(text).toContain("[major] 見出し");
    expect(text).toContain("本文");
    expect(text.endsWith("\n")).toBe(true);
  });

  // 端の値: 指摘 0 件。**空の文書にしない**（失敗と区別が付かなくなる）。
  it("指摘 0 件でもそう書く", () => {
    const text = toMarkdown(
      stored({
        files: [file({ text: { summary: "", findings: [], markdown: null, fallbackReason: null } })],
      }),
      CONTEXT,
    );
    expect(text).toContain("指摘はありませんでした。");
    expect(text).toContain("## a.ts");
  });

  // 端の値: 構造化に失敗した結果しか無い。**本文を捨てない。**
  it("構造化に失敗した結果は理由を添えて生出力を出す", () => {
    const text = toMarkdown(
      stored({
        files: [
          file({
            text: {
              summary: "",
              findings: [],
              markdown: "## モデルが書いた Markdown",
              fallbackReason: "構造化に失敗しました。",
            },
          }),
        ],
      }),
      CONTEXT,
    );
    expect(text).toContain("> 構造化に失敗しました。");
    expect(text).toContain("## モデルが書いた Markdown");
  });

  it("失敗したファイルは理由と生の応答を出す", () => {
    const text = toMarkdown(
      stored({
        failed: 1,
        files: [
          file({
            text: null,
            error: { kind: "status", message: "接続先がエラーを返しました", detail: "{...}" },
          }),
        ],
      }),
      CONTEXT,
    );
    expect(text).toContain("1 件のファイルはレビューに失敗しました");
    expect(text).toContain("接続先がエラーを返しました");
    expect(text).toContain("{...}");
  });

  // **中止したものと最後まで走ったものを見分けられること。**
  it("中止したことを書く", () => {
    expect(toMarkdown(stored({ cancelled: true }), CONTEXT)).toContain("途中で中止しました");
    expect(toMarkdown(stored(), CONTEXT)).not.toContain("途中で中止しました");
  });

  /**
   * **見出しに使う文字が混ざっても崩さない。** パスや指摘の見出しに `#` や
   * 改行が入ると、そこから先が別の見出しに見える。
   */
  it("見出しに入る文字を無害にする", () => {
    const text = toMarkdown(
      stored({
        files: [
          file({
            path: "a\n# にせの見出し.ts",
            text: {
              summary: "",
              findings: [finding({ title: "改行\n入り # の見出し" })],
              markdown: null,
              fallbackReason: null,
            },
          }),
        ],
      }),
      CONTEXT,
    );
    const headings = text.split("\n").filter((line) => line.startsWith("#"));
    expect(headings.some((line) => line.includes("にせの見出し"))).toBe(true);
    // 見出しの行は 1 行に潰れており、`#` は落ちている。
    expect(text).not.toContain("# にせの見出し.ts");
    expect(text).not.toContain("入り # の見出し");
  });

  /** 本文が ``` を含んでいても囲みを壊さない。 */
  it("生の応答にフェンスが入っていても囲みを壊さない", () => {
    const text = toMarkdown(
      stored({
        failed: 1,
        files: [
          file({
            text: null,
            error: { kind: "badResponse", message: "読めません", detail: "```\nこれ\n```" },
          }),
        ],
      }),
      CONTEXT,
    );
    expect(text).toContain("````");
  });

  // **どのリポジトリの何を見たのか**が書き出しに残ること。
  it("リポジトリと対象を書く", () => {
    const text = toMarkdown(stored(), CONTEXT);
    expect(text).toContain("- リポジトリ: givsoner");
    expect(text).toContain("bbbbbbbb「fix: 直す」");
  });

  // 端の値: リポジトリ名が分からない文脈。**その行だけ出さない**（空欄を書かない）。
  it("リポジトリ名が無ければその行を出さない", () => {
    const text = toMarkdown(stored(), NO_CONTEXT);
    expect(text).not.toContain("- リポジトリ:");
    expect(text).toContain("- 対象:");
  });

  it("ファイル 0 件でも落ちない", () => {
    const text = toMarkdown(stored({ files: [], summary: null }), CONTEXT);
    expect(text).toContain("# AI レビュー結果");
    expect(text).toContain("ファイル 0 件");
  });
});

describe("markdownFileName", () => {
  it("保存名から .md の名前を作る", () => {
    expect(markdownFileName(stored())).toBe("review-20260906T120431-1a2b3c4d.md");
  });
});
