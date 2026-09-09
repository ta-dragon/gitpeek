/**
 * チェックの入ったブランチを CSV にする（T-32。docs/DESIGN.md §6.4。純関数）。
 *
 * **ここが決めるのは「どの行を、どういう文字列にするか」だけ。** 保存先を選ぶのも
 * ファイルへ書くのもここではしない（CLAUDE.md §8 — 判定と整形は `src/lib` へ出す）。
 *
 * 時刻は **コミット時刻**を使う。rebase すると書き換わる値だが、
 * 「このブランチが最後に動いたのはいつか」を見るなら作者時刻より素直。
 */
import { ja } from "../i18n/ja";
import type { RefEntry } from "./ipc";
import type { CommitTimes } from "./refTree";
import { absoluteTimeDetailed } from "./relativeTime";

/** CSV の 1 行。 */
export type BranchCsvRow = {
  /** 表示名（`main` / `origin/main`）。 */
  shortName: string;
  /** グラフの外を指していて時刻を引けないときだけ null。 */
  time: number | null;
};

/** ローカルを先、リモートを後。ツリーの並びと同じにして、見比べられるようにする。 */
const KIND_ORDER = { localBranch: 0, remoteBranch: 1, tag: 2 } as const;

/**
 * CSV に出す行。**チェックの入っているブランチだけ**を、ローカル → リモートの順に並べる。
 *
 * **タグは入れない。** タグにはチェックボックスが無いので（CLAUDE.md §6）、
 * 入れると「外したはずなのに出てくる行」になる。
 */
export function branchCsvRows(
  refs: RefEntry[],
  excluded: ReadonlySet<string>,
  times: CommitTimes,
): BranchCsvRow[] {
  return refs
    .filter((entry) => entry.kind !== "tag" && !excluded.has(entry.name))
    .sort((a, b) => {
      const kind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      if (kind !== 0) return kind;
      // localeCompare は環境で並びが変わる。テストが再現するよう素の比較にする。
      return a.shortName < b.shortName ? -1 : a.shortName > b.shortName ? 1 : 0;
    })
    .map((entry) => ({
      shortName: entry.shortName,
      time: times.get(entry.target) ?? null,
    }));
}

/**
 * 保存できるか。**押せないときは理由を出すために、種類で返す**（CLAUDE.md §6）。
 *
 * 真偽値だと「0 件だから押せない」のか「そもそも対象外」なのかが呼び出し側で消える。
 */
export type CsvExportState = { kind: "ready"; count: number } | { kind: "empty" };

export function csvExportState(rows: BranchCsvRow[]): CsvExportState {
  return rows.length === 0 ? { kind: "empty" } : { kind: "ready", count: rows.length };
}

/**
 * Excel が CP932 と誤読しないように先頭へ置く。
 *
 * **無いと日本語のブランチ名が化ける。** UTF-8 だと気付かせる手立てが他にない。
 * **文字そのものを書かない**（見えないので、消えても気付けない）。
 */
const BOM = String.fromCharCode(0xfeff);

/**
 * CSV 本文。**行区切りは CRLF、先頭に BOM**（RFC 4180 と Excel に合わせる）。
 *
 * 時刻を引けなかった行は**空欄**にする。0 や「不明」を入れると、
 * 日付で並べ替えたときに本物の日時に混ざって見分けが付かなくなる。
 */
export function toCsv(rows: BranchCsvRow[]): string {
  const lines = [
    [ja.refTree.csv.headerName, ja.refTree.csv.headerTime].map(field).join(","),
    ...rows.map((row) =>
      [row.shortName, row.time === null ? "" : absoluteTimeDetailed(row.time)]
        .map(field)
        .join(","),
    ),
  ];
  return BOM + lines.join("\r\n") + "\r\n";
}

/**
 * RFC 4180 の囲み。
 *
 * **ブランチ名に `,` と `"` は入れられる。** git が禁じているのは空白や `~^:?*[` などで、
 * この 2 つは通る。囲まないと列がずれる。
 */
function field(value: string): string {
  return /["\r\n,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Windows がファイル名に使えない文字。バックスラッシュは実行時に足す。 */
const FORBIDDEN = '<>:"/|?*' + String.fromCharCode(92);

/**
 * 保存ダイアログに出す既定のファイル名。
 *
 * **リポジトリ名をそのまま使わない。** 登録名は利用者が自由に付けられるので、
 * Windows がファイル名に使えない文字が入っていることがある。
 */
export function csvFileName(repositoryName: string, at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  // Windows がファイル名に使えない文字（制御文字を含む）だけ潰す。
  // **日本語は残す。** 登録名はほぼ日本語なので、落とすと全部同じ名前になる。
  const stem = [...repositoryName]
    .map((ch) => (FORBIDDEN.includes(ch) || ch.charCodeAt(0) < 32 ? "-" : ch))
    .join("")
    .replace(/^[-.\s]+|[-.\s]+$/g, "");
  return stem === "" ? `branches-${stamp}.csv` : `branches-${stem}-${stamp}.csv`;
}
