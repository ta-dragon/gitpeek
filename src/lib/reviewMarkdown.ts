/**
 * レビュー結果を Markdown へ書き出す（T-23。純関数）。
 *
 * **保存形式は JSON のまま。Markdown は出力専用**（DESIGN.md §12.4）。
 * ここで作った文字列を読み戻すことはないので、**読みやすさだけを見る。**
 */
import { ja } from "../i18n/ja";
import type { Severity, StoredReview } from "./ipc";

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "critical",
  major: "major",
  minor: "minor",
  info: "info",
};

/**
 * 見出しに使う文字を無害にする。
 *
 * ファイルパスや指摘の見出しに `#` や改行が入ると、**そこから先が別の見出しに見える**。
 * 1 行に潰し、Markdown の記号を落とす。
 */
function inline(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/[`*_[\]#|]/g, "")
    .trim();
}

/** 本文はそのまま出すが、**フェンスの中に入れるときだけ**囲みを壊さないようにする。 */
function fenced(text: string): string {
  // 本文が ``` を含んでいたら、囲みのほうを長くする。
  const longest = [...text.matchAll(/`{3,}/g)].reduce(
    (max, match) => Math.max(max, match[0].length),
    2,
  );
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

/**
 * 1 件を Markdown にする。
 *
 * **指摘 0 件でも「0 件」と書く。** 空の文書を出すと、失敗したのか
 * 指摘が無かったのか区別が付かない。
 */
export function toMarkdown(stored: StoredReview): string {
  const { run, profile } = stored;
  const out: string[] = [];

  out.push(`# ${ja.review.markdown.title}`);
  out.push("");
  out.push(`- ${ja.review.markdown.savedAt}: ${stored.savedAt}`);
  out.push(`- ${ja.review.markdown.model}: ${inline(profile.model)}（${inline(profile.name)}）`);
  out.push(`- ${ja.review.markdown.target}: ${describeSource(stored)}`);
  out.push(
    `- ${ja.review.markdown.counts}: ${ja.review.markdown.fileCount(run.files.length)}` +
      ` / ${ja.review.markdown.findingCount(countAll(stored))}`,
  );
  if (run.failed > 0) out.push(`- ${ja.review.markdown.failed(run.failed)}`);
  // **中止したものと最後まで走ったものを見分けられるようにする。**
  if (run.cancelled) out.push(`- ${ja.review.markdown.cancelled}`);
  if (run.skills.length > 0) {
    out.push(`- ${ja.review.markdown.skills}: ${run.skills.map((it) => inline(it.name)).join(", ")}`);
  }
  out.push("");

  if (run.summary !== null) {
    out.push(`## ${ja.review.markdown.summary}`);
    out.push("");
    if (run.summary.markdown !== null) {
      out.push(`> ${inline(run.summary.fallbackReason ?? ja.review.fallbackDefault)}`);
      out.push("");
      out.push(run.summary.markdown);
    } else {
      out.push(run.summary.summary);
    }
    out.push("");
  }

  for (const file of run.files) {
    out.push(`## ${inline(file.path)}`);
    out.push("");

    if (file.error !== null) {
      out.push(`> ${inline(file.error.message)}`);
      if (file.error.detail !== "") {
        out.push("");
        out.push(fenced(file.error.detail));
      }
      out.push("");
      continue;
    }
    if (file.text === null) {
      out.push(ja.review.markdown.noResult);
      out.push("");
      continue;
    }
    if (file.text.markdown !== null) {
      out.push(`> ${inline(file.text.fallbackReason ?? ja.review.fallbackDefault)}`);
      out.push("");
      out.push(file.text.markdown);
      out.push("");
      continue;
    }

    if (file.text.summary !== "") {
      out.push(file.text.summary);
      out.push("");
    }
    if (file.text.findings.length === 0) {
      out.push(ja.review.markdown.noFindings);
      out.push("");
      continue;
    }
    for (const finding of file.text.findings) {
      const where = finding.line === null ? "" : `:${finding.line}`;
      out.push(
        `### [${SEVERITY_LABEL[finding.severity]}] ${inline(finding.title)}` +
          ` — ${inline(finding.file)}${where}`,
      );
      out.push("");
      out.push(finding.message);
      out.push("");
    }
  }

  return `${out.join("\n").trimEnd()}\n`;
}

function countAll(stored: StoredReview): number {
  return stored.run.files.reduce((total, file) => total + (file.text?.findings.length ?? 0), 0);
}

/** 何と何を比べたか。**作業ツリーも同じ形で書く。** */
export function describeSource(stored: StoredReview): string {
  const source = stored.run.source;
  if (source.kind === "workingTree") {
    return source.staged ? ja.review.source.staged : ja.review.source.unstaged;
  }
  const to = source.sha.slice(0, 8);
  if (source.parent === null) return ja.review.source.root(to);
  const from = source.parent.slice(0, 8);
  return source.symmetric
    ? ja.review.source.symmetric(from, to)
    : ja.review.source.range(from, to);
}

/** 書き出しの既定のファイル名。**時刻を入れて上書きを誘わない。** */
export function markdownFileName(stored: StoredReview): string {
  const stem = stored.file.replace(/\.json$/i, "");
  return `review-${stem}.md`;
}
