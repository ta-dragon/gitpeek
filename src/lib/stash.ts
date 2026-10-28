/**
 * stash を見る（T-42。docs/DESIGN.md §7.5.1。純関数）。
 *
 * **見るだけ。** 作成・適用・削除はどこにも無い（CLAUDE.md §1）。ここが決めるのは
 * 見出しの分け方・差分の 2 点・元のコミットへ移れるか・レビューの対象にできるか。
 *
 * **index と作業ツリーは分けない。** `git stash show` と同じく「元のコミット → stash」を
 * 1 つの差分にする（分けると 1 つの stash が 2 つの差分に割れて読みにくい）。
 * 未追跡のファイルだけは別の段にする（`git stash show` の既定では出ないので、黙って隠さない）。
 */
import type { DiffSource, StashEntry } from "./ipc";

/** 見出し。`branch` が null なら、メッセージを分けられなかった（そのまま `text` に入る）。 */
export type StashTitle = {
  branch: string | null;
  /** 名前を付けずに退避した（`WIP on …`）。git がその時のコミットの要約を入れている。 */
  unnamed: boolean;
  text: string;
};

/**
 * メッセージを「どのブランチで」と本文に分ける。
 *
 * git は `-m` があれば `On <ブランチ>: <文>`、無ければ `WIP on <ブランチ>: <短い SHA> <要約>` を書く。
 * detached では `<ブランチ>` が `(no branch)` になる。**分けられない形はそのまま出す**
 * （手で `stash store -m` したものなど）。ブランチ名に `:` は入らない（git が禁じている）ので、
 * 最初の `: ` で切ってよい。
 */
export function stashTitle(message: string): StashTitle {
  const match = /^(WIP on|On) ([^:]+): ([\s\S]*)$/.exec(message);
  if (match === null) return { branch: null, unnamed: false, text: message };
  return { branch: match[2], unnamed: match[1] === "WIP on", text: match[3] };
}

/** 一覧の段。追跡しているファイルの変更と、未追跡のファイル。 */
export type StashSection = "tracked" | "untracked";

/**
 * 段ごとの差分の 2 点。追跡ぶんは「元のコミット → stash」、未追跡ぶんは
 * 「なし（ルート）→ 第 3 親」（全行追加になる）。**未追跡が無ければ null。**
 */
export function stashSource(entry: StashEntry, section: StashSection): DiffSource | null {
  if (section === "tracked") {
    return { kind: "range", parent: entry.base, sha: entry.sha, symmetric: false };
  }
  return entry.untracked === null
    ? null
    : { kind: "range", parent: null, sha: entry.untracked, symmetric: false };
}

/**
 * 元のコミットへ移れるか。**移れないときは理由を種類で返す**（CLAUDE.md §6）。
 *
 * - `outside` — 読み込んだ集合に無い（退避したブランチを消した、など）
 * - `hidden` — 集合にはあるが、ブランチの表示を絞っていて行が無い
 */
export function stashBaseJump(
  base: string,
  inGraph: (sha: string) => boolean,
  shownShas: ReadonlySet<string>,
): "go" | "hidden" | "outside" {
  if (!inGraph(base)) return "outside";
  return shownShas.has(base) ? "go" : "hidden";
}

/**
 * AI レビューの対象。**追跡しているファイルの変更だけ**を対象にできる。
 *
 * 未追跡のファイルを見ているときは対象にしない（全行追加の差分で、元のコミットとの
 * つながりが無い）。**押せない形で残し、理由を出す**ために種類で返す。
 */
export type StashReview = { kind: "ok"; source: DiffSource } | { kind: "untracked" };

export function stashReview(entry: StashEntry, section: StashSection): StashReview {
  if (section === "untracked") return { kind: "untracked" };
  return { kind: "ok", source: stashSource(entry, "tracked") as DiffSource };
}

/**
 * 読み直したあとも同じ stash を見ていられるか。**SHA で引く**（`stash@{n}` は足すたびにずれる）。
 * 消えていれば null（見ていたものが無くなったので、見るのをやめる）。
 */
export function stillStashed(entries: readonly StashEntry[], sha: string | null): string | null {
  if (sha === null) return null;
  return entries.some((entry) => entry.sha === sha) ? sha : null;
}

/** 一覧のキー（キーボードで上下するため）。段とパスを 1 つの文字列にする。 */
export function stashFileKey(section: StashSection, path: string): string {
  return `${section}:${path}`;
}

export function parseStashFileKey(key: string): { section: StashSection; path: string } {
  const at = key.indexOf(":");
  const section = key.slice(0, at) === "untracked" ? "untracked" : "tracked";
  return { section, path: key.slice(at + 1) };
}
