/**
 * 「何をレビューしたのか」を 1 行にする（T-23 の追補。純関数）。
 *
 * **履歴が増えると、日時とモデルだけではどれがどれだか読めなくなる**
 * （2026-09-06 の目視で利用者から出た要望）。結果・履歴・書き出しの
 * **3 か所が同じ文言を出す**ように、組み立てはここだけに置く。
 *
 * **コミットの要約は保存していない。** 読み込み済みのコミットから引ければ添え、
 * 引けなければ SHA だけにする（`subjectOf` が `null` を返す）。保存した JSON に
 * 要約を足す手もあるが、**すでに積んである履歴が読めるようになるほう**を取った。
 */
import { ja } from "../i18n/ja";
import type { DiffSource } from "./ipc";

/**
 * 呼び出し側が用意する手掛かり。
 *
 * **省略できる形にしない。** 省略可能にすると、渡し忘れても型が通り、
 * 「常に `null` のまま一度も出ない」ができてしまう（T-19 で踏んだ形）。
 */
export type TargetContext = {
  /** リポジトリの表示名。分からなければ `null`。 */
  repositoryName: string | null;
  /** SHA からコミットの要約を引く。読み込んだ集合の外なら `null`。 */
  subjectOf: (sha: string) => string | null;
};

/** 何も引けない文脈。**書き出しのように SHA だけで足りる場所で使う。** */
export const NO_CONTEXT: TargetContext = { repositoryName: null, subjectOf: () => null };

/** 画面に出す SHA の長さ。 */
const SHA_CHARS = 8;

/** 要約をこの長さで切る。**ドロワーは狭い**ので、長い要約は 1 行に収める。 */
const SUBJECT_CHARS = 40;

/** 表示用の短い SHA。**短い入力はそのまま返す**（切り詰めない）。 */
export function shortSha(sha: string): string {
  return sha.slice(0, SHA_CHARS);
}

/**
 * 要約を 1 行に収める。
 *
 * **改行は空白に潰す**（`%s` が 1 行に潰しているはずだが、履歴には手で置かれた
 * ファイルも来る）。長いものは切って `…` を付ける。
 */
export function trimSubject(subject: string): string {
  const flat = subject.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  return flat.length <= SUBJECT_CHARS ? flat : `${flat.slice(0, SUBJECT_CHARS)}…`;
}

/**
 * コミット 1 つの呼び名。**要約が引けたときだけ添える。**
 *
 * 要約が空文字のコミット（メッセージなし）は、引けなかったのと区別が付くように
 * 「（メッセージなし）」と書く。
 */
export function commitLabel(sha: string, context: TargetContext): string {
  const found = context.subjectOf(sha);
  if (found === null) return shortSha(sha);
  const subject = trimSubject(found);
  return ja.review.source.commit(
    shortSha(sha),
    subject === "" ? ja.commits.emptySubject : subject,
  );
}

/**
 * 何をレビューしたのか。**記録が無くても行を消さない**（CLAUDE.md §6）。
 *
 * 要約を添えるのは**比べた先（`sha`）だけ**。親のほうにも付けると 1 行に収まらず、
 * どちらの要約なのかも読み取りにくくなる。
 */
export function describeTarget(source: DiffSource | null, context: TargetContext): string {
  if (source === null) return ja.review.source.unknown;
  if (source.kind === "workingTree") {
    return source.staged ? ja.review.source.staged : ja.review.source.unstaged;
  }

  const to = commitLabel(source.sha, context);
  if (source.parent === null) return ja.review.source.root(to);

  const from = shortSha(source.parent);
  return source.symmetric
    ? ja.review.source.symmetric(from, to)
    : ja.review.source.range(from, to);
}

/**
 * 履歴を開いたときに差分ペインを合わせる先（T-23 の受け入れ条件
 * 「**当時の差分と並べる**」）。
 *
 * **記録が無ければ何もしない**（`null`）。勝手にどこかへ動かすより、
 * いま見ているものを残すほうがよい。
 */
export type TargetSelection =
  | { kind: "workingTree" }
  | {
      kind: "commits";
      selectedCommit: string;
      /** 2 点比較のときだけ入る比較元。 */
      compareCommit: string | null;
      symmetric: boolean;
    };

/**
 * レビューした 2 点から、画面の選択を組み直す。
 *
 * **「コミットとその親」を 2 点比較として復元しない。** 同じ差分にはなるが、
 * 比較の見た目（比較バー）が残って「自分で比べ始めた」ように読める。
 * 親かどうかは、読み込んだコミットの**第一親**で判定する。
 *
 * **読み込んでいないコミットは第一親を引けない**ので 2 点比較として復元する。
 * 出る差分は同じ（親 → そのコミット）で、見た目だけが比較になる。
 */
export function selectionForSource(
  source: DiffSource | null,
  firstParentOf: (sha: string) => string | null,
): TargetSelection | null {
  if (source === null) return null;
  if (source.kind === "workingTree") return { kind: "workingTree" };

  const parent = source.parent;
  if (parent === null || (!source.symmetric && firstParentOf(source.sha) === parent)) {
    return {
      kind: "commits",
      selectedCommit: source.sha,
      compareCommit: null,
      symmetric: false,
    };
  }
  return {
    kind: "commits",
    selectedCommit: source.sha,
    compareCommit: parent,
    symmetric: source.symmetric,
  };
}
