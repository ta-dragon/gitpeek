/** Rust 側 (`src-tauri`) との境界。invoke の呼び出しはすべてここを通す。 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** `src-tauri/src/commandlog.rs` の `CommandLogEntry` に対応。 */
export type CommandLogEntry = {
  id: number;
  startedAt: string;
  program: string;
  /** 全呼び出しに固定付与される `-c ...` 群。画面では淡色で表示する。 */
  fixedArgs: string[];
  repo: string | null;
  args: string[];
  /** プロセスの起動自体に失敗した場合は null。 */
  exitCode: number | null;
  stderr: string;
  durationMs: number;
  ok: boolean;
};

/** `src-tauri/src/git/detect.rs` の `GitStatus` に対応。 */
export type GitStatus = {
  found: boolean;
  path: string;
  version: string | null;
  versionOk: boolean;
  minVersion: string;
  error: string | null;
};

/**
 * バックエンドに到達できず `GitStatus` を取得できなかったときの表示用。
 * `src-tauri/src/git/detect.rs` の `MIN_MAJOR`/`MIN_MINOR` と一致させること。
 */
export const MIN_VERSION_FALLBACK = "2.20";

/** アプリを先へ進めてよい状態か。 */
export function isGitUsable(status: GitStatus): boolean {
  return status.found && status.versionOk;
}

export function detectGit(path?: string): Promise<GitStatus> {
  return invoke<GitStatus>("detect_git", { path: path ?? null });
}

export function listCommandLog(): Promise<CommandLogEntry[]> {
  return invoke<CommandLogEntry[]>("list_command_log");
}

/* ---------- リポジトリ（`src-tauri/src/git/repo.rs`）---------- */

/** HEAD の 3 状態。`kind` で判別する。 */
export type HeadState =
  | { kind: "branch"; name: string; sha: string }
  | { kind: "detached"; sha: string }
  /** コミット 0 件。ブランチ名だけが決まっている。 */
  | { kind: "unborn"; name: string };

export type RepositoryProbe = {
  isRepository: boolean;
  gitDir: string | null;
  /** bare では null。 */
  workTree: string | null;
  isBare: boolean;
  isShallow: boolean;
  head: HeadState | null;
  /**
   * 登録されているリモート名。
   *
   * **空なら fetch の放置警告を出さない。** fetch しても `FETCH_HEAD` はできないので、
   * 出すとローカルだけのリポジトリで永久に出続ける。
   */
  remotes: string[];
  /**
   * 最後に fetch した時刻（`FETCH_HEAD` の mtime。Unix ミリ秒）。
   *
   * **アプリ側では記録していない。** 独自に持つと、ターミナルで `git fetch` した
   * 直後に「10 日 fetch していません」と誤警告する。null は一度も fetch していない。
   */
  lastFetchAtMs: number | null;
  /** 検出するだけ。アプリからは削除しない。 */
  indexLockPresent: boolean;
  error: string | null;
};

/** 登録内容に実際の状態を添えたもの。`probe` が null ならパスが消えている。 */
export type RepositoryEntry = RepositorySettings & {
  probe: RepositoryProbe | null;
  /**
   * しばらく fetch していないか（docs/DESIGN.md §8.3）。
   *
   * **判定は Rust 側の `git::ops::is_stale` の 1 箇所だけ。** ここで日数を数え直すと、
   * 「リモートが無ければ警告しない」「閾値 0 で無効」が二重管理になる。
   */
  fetchStale: boolean;
};

export function probeRepository(path: string): Promise<RepositoryProbe> {
  return invoke<RepositoryProbe>("probe_repository", { path });
}

/** フォルダ配下の git リポジトリを探す。`maxDepth` の既定は 4。 */
export function scanRepositories(
  root: string,
  maxDepth?: number,
): Promise<string[]> {
  return invoke<string[]>("scan_repositories", { root, maxDepth: maxDepth ?? null });
}

/** 登録する。同じパスが登録済みならその登録が返る。 */
export function addRepository(path: string): Promise<RepositorySettings> {
  return invoke<RepositorySettings>("add_repository", { path });
}

/** 登録を解除する。フォルダには触らない。 */
export function removeRepository(id: string): Promise<void> {
  return invoke<void>("remove_repository", { id });
}

export function listRepositories(): Promise<RepositoryEntry[]> {
  return invoke<RepositoryEntry[]>("list_repositories");
}

/* ---------- グラフ素材（`src-tauri/src/model.rs`）---------- */

/** コミット 1 件のメタ情報。本文と差分は含まない（選択時に遅延取得する）。 */
export type CommitMeta = {
  sha: string;
  /** `%h`。何桁で一意になるかは git に委ねている。 */
  shortSha: string;
  /** 第一親が先頭。マージは 2 件以上、ルートコミットは 0 件。 */
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Unix 秒。表示形式はフロント側で決める。 */
  authorTime: number;
  commitTime: number;
  subject: string;
};

export type RefKind = "localBranch" | "remoteBranch" | "tag";

export type RefEntry = {
  /** 完全な ref 名（`refs/heads/main`）。同名の別種を取り違えないための正。 */
  name: string;
  /** 表示用（`main` / `origin/main` / `v1.0`）。 */
  shortName: string;
  kind: RefKind;
  /** 指すコミット SHA。annotated tag は peel 後。 */
  target: string;
  upstream: string | null;
  /** 読み込んだコミット集合に含まれない。ジャンプを無効化する。 */
  outOfGraph: boolean;
  /** 幹とコミットを 1 つも共有しない履歴を指している（`git checkout --orphan` 由来）。 */
  orphan: boolean;
};

export type HeadInfo = {
  /** コミット 0 件（unborn）のときだけ null。 */
  sha: string | null;
  /** detached のときだけ null。 */
  branch: string | null;
  detached: boolean;
  unborn: boolean;
};

/** リポジトリ 1 つ分の読み込み結果。グラフはこれだけを材料に描く。 */
export type RepositorySnapshot = {
  /** topo-order。date-order への切替は再実行せずメモリ上で並べ替える。 */
  commits: CommitMeta[];
  refs: RefEntry[];
  head: HeadInfo;
  /** lane 0 を予約する幹の ref 名（完全形）。 */
  defaultBranch: string | null;
  loadedAt: string;
  /** 全 ref と HEAD の指紋。Rust 側のキャッシュ判定に使う。 */
  refFingerprint: string;
};

/** 読み込みの段階。所要時間の内訳がそのまま段階になっている。 */
export type LoadPhase = "refs" | "commits" | "graph" | "transfer";

/** `snapshot-progress` イベントの中身。 */
export type SnapshotProgress = {
  /** どのリポジトリの進捗か。切替直後に前の進捗が届くので必ず見ること。 */
  repositoryId: string;
  phase: LoadPhase;
  commits: number;
  /** 前回の件数を分母にした**概算**。初回は null。 */
  estimatedTotal: number | null;
  elapsedMs: number;
};

/**
 * 全コミットのメタ情報と ref 一覧をまとめて読む。
 *
 * ref の指紋が前回と同じなら Rust 側がキャッシュを返し、`git log` は走らない。
 * `force` は fetch / checkout の直後に立てる（T-17 / T-18）。
 * `estimatedCommits` は前回の件数で、進捗の割合表示にしか使われない。
 */
export function loadRepositorySnapshot(
  repositoryId: string,
  force = false,
  estimatedCommits: number | null = null,
): Promise<RepositorySnapshot> {
  return invoke<RepositorySnapshot>("load_repository_snapshot", {
    repositoryId,
    force,
    estimatedCommits,
  });
}

/* ---------- fetch（`src-tauri/src/git/ops.rs`）---------- */

/**
 * fetch の結果。
 *
 * `partial` は**一部だけ取り込めた**（いまのところ上流がタグを付け替えていて、
 * そのタグだけ更新できなかった場合）。**失敗と分けている** — ブランチは取り込めて
 * いるのに「失敗」と出ると、直しようがないのに壊れたように見える。
 */
export type FetchStatus = "success" | "partial" | "failed" | "cancelled";

export type FetchOutcome = {
  status: FetchStatus;
  /** 画面に出す 1 行。失敗の理由はここで人間向けに言い換えてある。 */
  message: string;
  /** 進捗ではなかった stderr の行。**Rust 側で秘匿情報を伏せてある。** */
  lines: string[];
  durationMs: number;
};

/** `fetch-progress` イベントの中身。 */
export type FetchProgress = {
  /** どのリポジトリの進捗か。一括 fetch では次々と変わる。 */
  repositoryId: string;
  /** git が出した見出しそのまま。**翻訳されていることがある。** */
  label: string;
  done: number;
  /** 分母が分からない段階は null（バーは不定表示になる）。 */
  total: number | null;
  elapsedMs: number;
};

/**
 * リモートから取ってくる（`fetch --all --prune --tags --progress`）。
 *
 * **一括 fetch はこれを 1 件ずつ呼ぶ。** 並列にすると認証ウィンドウが同時に何枚も開く。
 * 中止しても、そこまでに更新された ref は戻らない。
 */
export function fetchRepository(repositoryId: string): Promise<FetchOutcome> {
  return invoke<FetchOutcome>("fetch_repository", { repositoryId });
}

/** 実行中の fetch を止める。走っていなければ何もしない。 */
export function cancelFetch(): Promise<void> {
  return invoke<void>("cancel_fetch");
}

/* ---------- clone（T-19。`src-tauri/src/git/ops.rs`）---------- */

/**
 * clone の依頼。**Rust 側の `git::ops::CloneRequest` と同じ形。**
 *
 * 保存先を「親フォルダ」と「フォルダ名」に分けて渡し、繋ぐのは Rust 側。
 * 区切り文字の扱いを 2 か所に持たないため。**画面に出すパスはプレビューであり、
 * 実際に作られた場所は `CloneOutcome.path` が正。**
 */
export type CloneRequest = {
  /** HTTPS / SSH / ローカルパス。**git へそのまま渡る**（アプリは解釈しない）。 */
  url: string;
  /** clone 先の親フォルダ。**フルパスで渡すこと**（相対は Rust 側が弾く）。 */
  parentDirectory: string;
  /** そこへ作るフォルダの名前。 */
  folderName: string;
  /**
   * サブモジュールも取り込むか（`--recurse-submodules`）。
   *
   * **既定は false。** 確認画面でチェックされたときだけ true にする
   * （CLAUDE.md §1 — 黙って取り込まない）。**Rust 側に `serde(default)` は無い**ので、
   * 送り忘れるとコマンドが 1 度も走らない。
   */
  recurseSubmodules: boolean;
};

/** `cancelled` は利用者が止めた場合。**残骸は消してある。** */
export type CloneStatus = "success" | "failed" | "cancelled";

export type CloneOutcome = {
  status: CloneStatus;
  /** 画面に出す 1 行。 */
  message: string;
  /** 進捗ではなかった stderr の行。**Rust 側で秘匿情報を伏せてある。** */
  lines: string[];
  durationMs: number;
  /** 成功したときの clone 先（絶対パス）。**登録にはこれを使う。** */
  path: string | null;
  /** 消さずに残した残骸の場所。消せていれば null。 */
  leftover: string | null;
};

/** `clone-progress` イベントの中身。**fetch とはイベント名を分けてある。** */
export type CloneProgress = {
  /** git が出した見出しそのまま。**翻訳されていることがある。** */
  label: string;
  done: number;
  /** 分母が分からない段階は null（バーは不定表示になる）。 */
  total: number | null;
  elapsedMs: number;
};

/**
 * URL から clone する（`clone --progress <url> <dir>`）。
 *
 * **登録はしない。** 成功したパスが返るので、登録と選択は呼び出し側が行う。
 * **失敗・中止のときは Rust 側が残骸を消す**（自分が作ったフォルダだけ）。
 */
export function cloneRepository(request: CloneRequest): Promise<CloneOutcome> {
  return invoke<CloneOutcome>("clone_repository", { request });
}

/** 実行中の clone を止める。走っていなければ何もしない。 */
export function cancelClone(): Promise<void> {
  return invoke<void>("cancel_clone");
}


/* ---------- checkout と FF マージ（T-18。`src-tauri/src/git/ops.rs`）---------- */

/** 実行を止める理由。**1 つでもあれば走らせない。** */
export type Blocker = "bare" | "dirty" | "indexLock" | "unborn";

/**
 * 書き込み前の判定。
 *
 * **判定は Rust 側の `git::ops::preflight` の 1 箇所だけ。** ここで条件を組み直すと、
 * 起動点（右クリック / ダブルクリック / グラフ行 / 上流の取り込み）ごとに結論が食い違う。
 */
export type WriteGuard = {
  blockers: Blocker[];
  /** 未追跡ファイルの数。**止める理由ではない**が、確認画面には出す。 */
  untracked: number;
  /** 手を入れたファイルの数（ステージ済み ＋ 未ステージ ＋ 衝突）。 */
  changed: number;
};

export function isAllowed(guard: WriteGuard): boolean {
  return guard.blockers.length === 0;
}

/**
 * checkout の対象。**渡し方が形で変わる**（docs/DESIGN.md §8.1。実測）。
 *
 * - `branch` … 既にあるローカルブランチ。**短い名前**（完全な ref 名だと detached になる）
 * - `detach` … **完全な ref 名か SHA**（短い名前だと DWIM がブランチを勝手に作る）
 * - `track`  … リモート追跡ブランチからローカルブランチを作る。
 *   **利用者が確認画面で選んだときだけ**（CLAUDE.md §1）
 */
export type CheckoutTarget =
  | { kind: "branch"; name: string }
  | { kind: "detach"; rev: string }
  | { kind: "track"; remoteRef: string; branch: string };

export type WriteOutcome = {
  ok: boolean;
  message: string;
  /** 生の stderr（マスキング済み）。展開して見せる。 */
  details: string[];
  /** 実行の直前に判定が変わっていたら、その内訳。走っていない。 */
  refused: WriteGuard | null;
};

/** 走らせてよいかを聞く。**確認画面を出す前に必ず通す。** */
export function preflightWrite(repositoryId: string): Promise<WriteGuard> {
  return invoke<WriteGuard>("preflight_write", { repositoryId });
}

/**
 * checkout する（docs/DESIGN.md §8.1）。
 *
 * **`--force` も自動 stash も無い**（CLAUDE.md §1）。Rust 側が実行の直前にもう一度
 * 判定を通し、通らなければ走らせずに `refused` を返す。
 */
export function checkout(
  repositoryId: string,
  target: CheckoutTarget,
): Promise<WriteOutcome> {
  return invoke<WriteOutcome>("checkout", { repositoryId, target });
}

/** fast-forward マージ（`merge --ff-only` 固定。CLAUDE.md §1）。 */
export function mergeFf(repositoryId: string, rev: string): Promise<WriteOutcome> {
  return invoke<WriteOutcome>("merge_ff", { repositoryId, rev });
}

/** HEAD と相手の ahead/behind。**`ahead === 0 && behind > 0` のときだけ FF できる。** */
export type MergeCheck = {
  ahead: number;
  behind: number;
  /** どちらも読み込んだコミット集合にあるか。false なら判定できない。 */
  known: boolean;
};

export function mergeCheck(repositoryId: string, revSha: string): Promise<MergeCheck> {
  return invoke<MergeCheck>("merge_check", { repositoryId, revSha });
}

/* ---------- レーン割り当て（`src-tauri/src/graph/lane.rs`）---------- */

/** 表示順。topo が既定。date は「この表示では線が交差します」の注記を出す。 */
export type GraphOrder = "topo" | "date";

/** ある行から親へ伸びる線 1 本。 */
export type GraphEdge = {
  fromLane: number;
  toLane: number;
  parentSha: string;
  /** 第一親以外（マージの右側）。オクトパスの 3 親目以降も true。 */
  isMergeSecondParent: boolean;
};

/** 描画 1 行分。**色も座標も持たない**（決めるのは T-06 の純関数）。 */
export type GraphRow = {
  sha: string;
  /** このコミットのノードが乗るレーン。lane 0 は幹に予約されている。 */
  lane: number;
  /** この行を素通りするレーン。縦線だけを引く。 */
  passing: number[];
  edges: GraphEdge[];
};

export type LaneLayout = {
  /** `RepositorySnapshot.commits` と 1 対 1。並び順は `order` に従う。 */
  rows: GraphRow[];
  /** 実際に使われた最大のレーン番号。グラフ列の幅はこれで決まる。 */
  maxLane: number;
};

/** 表示する ref を全部にしておく既定値。`settings.json` の初期値と同じ。 */
export const ALL_REFS: VisibleRefs = { mode: "all", excluded: [] };

/**
 * 描画用のレーンを確定する。
 *
 * コミットは Rust 側のキャッシュから取るので、`loadRepositorySnapshot` の直後に
 * 呼んでも `git log` は走らない。並び順の切替も可視 ref の変更も再実行にはならない。
 *
 * `visibleRefs` を絞ると**到達可能集合を計算し直して行と線が実際に減る**
 * （淡色化ではない — CLAUDE.md §3-7）。タグは起点 ref にしないので、
 * タグを外してもグラフは変わらない。
 */
export function computeLaneLayout(
  repositoryId: string,
  visibleRefs: VisibleRefs = ALL_REFS,
  order: GraphOrder = "topo",
): Promise<LaneLayout> {
  return invoke<LaneLayout>("compute_lane_layout", { repositoryId, visibleRefs, order });
}

/** `src-tauri/src/graph/reach.rs` の `BranchStatus` に対応。 */
export type BranchStatus = {
  /** 完全な ref 名（`refs/heads/main`）。 */
  refName: string;
  /** 比べた相手（上流）の完全な ref 名。 */
  upstream: string;
  ahead: number;
  behind: number;
};

/**
 * 上流を持つローカルブランチの ahead/behind。
 *
 * **`git rev-list --count` は走らない**（CLAUDE.md §2）。手元のコミットの親子関係から
 * 数えるので、ブランチが何本あってもプロセスは増えない。
 */
export function computeBranchStatus(repositoryId: string): Promise<BranchStatus[]> {
  return invoke<BranchStatus[]>("compute_branch_status", { repositoryId });
}

/* ---------- コミット詳細と変更ファイル（`src-tauri/src/git/diff.rs`）---------- */

/**
 * コミット 1 件の本文。
 *
 * 一覧の [`CommitMeta`] と重なるが、**コミッターと本文はここにしかない**。
 * 全コミットの本文をスナップショットに載せると数万コミットで数百 MB になるので、
 * 選択したコミットのぶんだけ取りに行く。
 */
export type CommitDetail = {
  sha: string;
  shortSha: string;
  /** 第 1 親が先頭。ルートコミットは空。 */
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  subject: string;
  /** subject を除いた本文。無ければ空文字。 */
  body: string;
};

export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  /** 通常ファイル ↔ シンボリックリンクなど。 */
  | "typeChanged"
  | "unknown";

export type FileChange = {
  /** 変更後のパス。差分の取得と表示にはこちらを使う。 */
  path: string;
  /** リネーム / コピー元。それ以外は null。 */
  oldPath: string | null;
  status: ChangeStatus;
  /** **バイナリでは null**（numstat が `-` を返す）。0 と取り違えないこと。 */
  additions: number | null;
  deletions: number | null;
  /** 変更前後のファイルモード（`100644` / 追加や削除では `000000`）。 */
  oldMode: string;
  newMode: string;
};

/** 行数が取れないファイル。numstat が `-` を返すのはバイナリのときだけ。 */
export function isBinaryChange(change: FileChange): boolean {
  return change.additions === null && change.deletions === null;
}

export function loadCommitDetail(
  repositoryId: string,
  sha: string,
): Promise<CommitDetail> {
  return invoke<CommitDetail>("load_commit_detail", { repositoryId, sha });
}

/**
 * 変更ファイル一覧。
 *
 * **`parent` は呼び出し側が決める。** マージコミットは差分が一意に決まらないので、
 * 既定は第 1 親（docs/DESIGN.md §7.4）。**ルートコミットでは null** を渡すこと
 * （空ツリーとの差分になる）。
 */
/**
 * コミットメッセージをそのまま（`%B`）。**コピー用。**
 *
 * `loadCommitDetail` の `subject` + `body` から組み立て直さないこと。
 * **`%s` は最初の段落を 1 行に潰す**ので、要約が複数行にまたがるコミットで改行が消える。
 */
export function loadCommitMessage(repositoryId: string, sha: string): Promise<string> {
  return invoke<string>("load_commit_message", { repositoryId, sha });
}

export function loadChangedFiles(
  repositoryId: string,
  sha: string,
  parent: string | null,
  /** `A...B`（マージベース起点）で比べる。2 点比較のときだけ意味を持つ（§10.3）。 */
  symmetric = false,
): Promise<FileChange[]> {
  return invoke<FileChange[]>("load_changed_files", {
    repositoryId,
    sha,
    parent,
    symmetric,
  });
}

/* ---------- 差分本体（`src-tauri/src/git/diff.rs`）---------- */

export type DiffLineKind = "context" | "added" | "removed";

export type DiffLine = {
  kind: DiffLineKind;
  /** 変更前の行番号。追加行では null。 */
  oldLine: number | null;
  /** 変更後の行番号。削除行では null。 */
  newLine: number | null;
  /** **末尾の CR は落としてある。** 行中の CR は残る（CR だけのファイル）。 */
  text: string;
  /** この行の改行。**null は「ファイル末尾に改行が無い」**。 */
  ending: LineEnding | null;
};

export type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** `@@ ... @@` の後ろ（関数名など）。無ければ空。 */
  heading: string;
  lines: DiffLine[];
};

/**
 * ファイル 1 つ分の差分。
 *
 * **モードとリネーム元は入っていない。** `FileChange` に既にあるので、
 * 差分ヘッダを作るために取り直さない（docs/DESIGN.md §9.3）。
 */
export type FileDiff = {
  path: string;
  /** `Binary files ... differ` だった。`hunks` は空。 */
  binary: boolean;
  encoding: TextEncoding;
  hadBom: boolean;
  lossy: boolean;
  lineEndings: LineEndingCounts;
  /** 代表の改行コード。**Rust 側で計算済み**（同じ規則を 2 言語で持たない）。 */
  dominantLineEnding: LineEnding | null;
  mixedLineEndings: boolean;
  /**
   * バイナリのときだけ入るバイト数。**追加 / 削除では片側が null**。
   * **0 と混同しないこと**（0 は「空のファイルになった」の意味になる）。
   */
  oldSize: number | null;
  newSize: number | null;
  hunks: Hunk[];
};

/* ---------- 作業ツリー（`src-tauri/src/git/status.rs`）---------- */

/**
 * 作業ツリーの状態（docs/DESIGN.md §7.5）。**read-only。**
 * stage / unstage / discard / stash を頼む経路はここに無い（CLAUDE.md §1）。
 */
export type WorkingTree = {
  /** HEAD と index の差。 */
  staged: FileChange[];
  /** index と作業ツリーの差。 */
  unstaged: FileChange[];
  /** 未追跡ファイルのパス。**差分にはしない**（全文で見せる）。 */
  untracked: string[];
  /** 衝突しているパス。ステージ済みでも未ステージでもない。 */
  unmerged: string[];
  /** `.git/index.lock` が残っている。**消さない。表示するだけ。** */
  indexLockPresent: boolean;
};

/** どのセクションのファイルか。差分の取り方がこれで決まる。 */
export type WorkingSection = "staged" | "unstaged" | "untracked" | "unmerged";

/** 未追跡ファイルの中身。 */
export type WorkingFile = {
  path: string;
  size: number;
  /** バイナリでも大きすぎるときでも null。 */
  text: DecodedText | null;
  binary: boolean;
  tooLarge: boolean;
};

export function loadWorkingTree(repositoryId: string): Promise<WorkingTree> {
  return invoke<WorkingTree>("load_working_tree", { repositoryId });
}

export function loadWorkingFile(repositoryId: string, path: string): Promise<WorkingFile> {
  return invoke<WorkingFile>("load_working_file", { repositoryId, path });
}

/** コンテキスト行の選択肢。「すべて」は十分大きな `-U` で代用する。 */
export const ALL_CONTEXT_LINES = 1_000_000;

/**
 * ファイル 1 つの差分を取る。
 *
 * **リネームでは `oldPath` を必ず渡すこと。** 新しいパスだけを渡すと git は
 * リネームを検出できず、**全行が追加された新規ファイル**として返す。
 * `parent` は `loadChangedFiles` と同じく **null がルートコミット**。
 */
/**
 * 差分の出どころ。**真偽値を並べず種類で分ける** — 平らに並べると
 * 成り立たない組み合わせ（作業ツリーなのに SHA がある等）が表現できてしまう。
 */
export type DiffSource =
  | { kind: "range"; parent: string | null; sha: string; symmetric: boolean }
  | { kind: "workingTree"; staged: boolean };

export function loadFileDiff(options: {
  repositoryId: string;
  source: DiffSource;
  path: string;
  oldPath: string | null;
  contextLines: number;
  ignoreWhitespace: boolean;
  /** 文字コードの手動上書き。null なら自動判別。 */
  forcedEncoding: TextEncoding | null;
}): Promise<FileDiff> {
  return invoke<FileDiff>("load_file_diff", options);
}

/* ---------- 文字コードと改行（`src-tauri/src/encoding.rs`）---------- */

/**
 * 判別・指定できる文字コード（docs/DESIGN.md §9.1）。
 *
 * **判別は順序で決めている**（UTF-8 → Shift_JIS → EUC-JP）ため、
 * EUC-JP のひらがなは Shift_JIS と判定される。直す手段は手動上書き。
 */
export type TextEncoding = "utf8" | "shiftJis" | "eucJp";

export type LineEnding = "lf" | "crlf" | "cr";

/** 改行の内訳。**CRLF は CR と LF に二重計上されていない**。 */
export type LineEndingCounts = { lf: number; crlf: number; cr: number };

export type DecodedText = {
  text: string;
  encoding: TextEncoding;
  /** UTF-8 BOM を取り除いたか。 */
  hadBom: boolean;
  /** 置換文字（U+FFFD）が出たか。手動上書きを間違えたときの合図。 */
  lossy: boolean;
  lineEndings: LineEndingCounts;
};

/** バイナリはデコードしない。`size` は元のバイト数。 */
export type Decoded = ({ kind: "binary"; size: number }) | ({ kind: "text" } & DecodedText);

/* ---------- settings.json（`src-tauri/src/store/settings.rs`）---------- */

export type ThemePreference = "system" | "light" | "dark";

export type GitSettings = {
  /** PATH 上に git が無い場合のフルパス。 */
  path: string | null;
};

export type VisibleRefs = {
  mode: "all" | "custom";
  excluded: string[];
};

export type RepoSkillTrust = {
  /** リポジトリ内 skill は既定で無効（CLAUDE.md §4）。 */
  trusted: boolean;
  hashes: Record<string, string>;
};

/** T-02 で使う。T-01 では常に空配列。 */
export type RepositorySettings = {
  id: string;
  name: string;
  path: string;
  order: number;
  visibleRefs: VisibleRefs;
  defaultLlmProfileId: string | null;
  repoSkills: RepoSkillTrust;
};

/**
 * **API キーはここに持たない。** 実体は Windows 資格情報マネージャーにあり、
 * ここにあるのは参照キーだけ（CLAUDE.md §4）。
 *
 * `id` と `credentialKey` を決めるのは Rust 側（`Store::upsert_llm_profile`）。
 * 新規は両方とも空で送る。
 */
export type LlmProfile = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  contextWindow: number;
  temperature: number;
  maxTokens: number;
  credentialKey: string;
};

export type UiSettings = {
  theme: ThemePreference;
  dateFormat: "relative" | "absolute";
  diffLayout: "side-by-side" | "unified";
  contextLines: number;
  ignoreWhitespace: boolean;
  showLineEndings: boolean;
  commitOrder: "topo" | "date";
  /** この行数を超える差分は既定で折りたたむ（docs/DESIGN.md §7.2）。 */
  collapseLines: number;
  /** 同じくバイト数。どちらか一方でも超えたら折りたたむ。 */
  collapseBytes: number;
  /**
   * git コマンドログのパネルを出すか（T-25）。**既定は出す。**
   *
   * 切り替えは**設定画面の「一般」だけ**（ヘッダのボタンは畳んだ）。
   * 設定に持つのは、隠したまま再起動しても戻らないようにするため。
   */
  showCommandLog: boolean;
};

export type FetchSettings = { staleWarningDays: number };

export type ReviewSettings = { concurrency: number; contextLines: number };

export type Settings = {
  schemaVersion: number;
  git: GitSettings;
  workspaceRoot: string | null;
  repositories: RepositorySettings[];
  llmProfiles: LlmProfile[];
  ui: UiSettings;
  fetch: FetchSettings;
  review: ReviewSettings;
};

/** 壊れた settings.json を退避したときの記録。 */
export type SettingsRecovery = { backupPath: string; reason: string };

export type SettingsPayload = {
  settings: Settings;
  /** 退避と再生成が起きたときだけ入る。 */
  recovered: SettingsRecovery | null;
};

/**
 * バックエンドから設定を取得できるまでの表示用。
 * `src-tauri/src/store/settings.rs` の各 `Default` 実装と一致させること。
 */
export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  git: { path: null },
  workspaceRoot: null,
  repositories: [],
  llmProfiles: [],
  ui: {
    theme: "system",
    dateFormat: "relative",
    diffLayout: "side-by-side",
    contextLines: 3,
    ignoreWhitespace: false,
    showLineEndings: false,
    commitOrder: "topo",
    collapseLines: 3_000,
    collapseBytes: 512_000,
    showCommandLog: true,
  },
  fetch: { staleWarningDays: 7 },
  review: { concurrency: 1, contextLines: 10 },
};

/* ---------- state.json（`src-tauri/src/store/state.rs`）---------- */

export type WindowBounds = { x: number; y: number; width: number; height: number };

export type PaneRatios = {
  sidebarWidth: number;
  graphDiffSplit: number;
  /** 右のコミット情報ペイン（詳細 ＋ 変更ファイル一覧）の幅（px）。 */
  commitInfoWidth: number;
  reviewDrawerWidth: number;
};

export type ColumnWidths = {
  /** グラフ列。レーン数に上限が無いので、ここを引っ張って合わせる。 */
  graph: number;
  subject: number;
  author: number;
  date: number;
  sha: number;
};

export type RepositoryUiState = {
  /** 最後に開いた時刻（RFC 3339）。「最終アクセス順」の並べ替えに使う。 */
  lastOpenedAt: string | null;
  /** 前回読み込んだコミット数。進捗の割合表示の分母にするだけの概算値。 */
  lastCommitCount: number | null;
  selectedCommit: string | null;
  /** 2 点比較の**比較元**（T-15）。null なら比較していない。比較先は `selectedCommit`。 */
  compareCommit: string | null;
  scrollOffset: number;
  selectedFile: string | null;
  /**
   * ブランチ / タグツリーで**畳んでいる**ノードの ID（T-10）。
   * 展開ではなく畳んだ側を持つので、空配列は「すべて既定（＝展開）」を意味する。
   */
  collapsedTreeNodes: string[];
  columnWidths: ColumnWidths;
};

export type UiState = {
  schemaVersion: number;
  lastRepositoryId: string | null;
  windowBounds: WindowBounds | null;
  paneRatios: PaneRatios;
  repositoryListSort: "manual" | "recent";
  perRepository: Record<string, RepositoryUiState>;
};

export function loadSettings(): Promise<SettingsPayload> {
  return invoke<SettingsPayload>("load_settings");
}

export function saveSettings(settings: Settings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}

export function loadUiState(): Promise<UiState> {
  return invoke<UiState>("load_ui_state");
}

/** Rust 側で 300ms デバウンスされるので、高頻度に呼んでよい。 */
export function saveUiState(uiState: UiState): Promise<void> {
  return invoke<void>("save_ui_state", { uiState });
}

export function appDataDir(): Promise<string> {
  return invoke<string>("app_data_dir");
}

/* ---------- ログ（`src-tauri/src/logging.rs`。T-24）---------- */

/**
 * ログの置き場所と、書けているかどうか。
 *
 * **書けていないことを画面に出す**ために持つ（CLAUDE.md §6）。黙って落とすと
 * 「書いているつもり」になる。
 */
export type LogStatus = {
  /** ログフォルダ。**空なら場所すら決まっていない。** */
  dir: string;
  writing: boolean;
  /** 書けていない理由。null なら書けている。 */
  problem: string | null;
};

export function logStatus(): Promise<LogStatus> {
  return invoke<LogStatus>("log_status");
}

/**
 * ログフォルダを開く。
 *
 * **開けるのはログフォルダだけ**（パスは Rust 側が持っており、こちらから渡さない）。
 */
export function openLogFolder(): Promise<void> {
  return invoke<void>("open_log_folder");
}

/**
 * フロントで起きた例外をログへ残す。
 *
 * 画面の受け皿は閉じると何も残らないので、**Rust 側と同じファイルへ並べる**。
 */
export function logFrontendError(message: string): Promise<void> {
  return invoke<void>("log_frontend_error", { message });
}

const PANIC_EVENT = "app-panic";

/** Rust 側が落ちたことの知らせ。**本文はマスク済み。** */
export type PanicEvent = { message: string };

export function onAppPanic(handler: (event: PanicEvent) => void): Promise<UnlistenFn> {
  return listen<PanicEvent>(PANIC_EVENT, (event) => handler(event.payload));
}

/* ---------- LLM（`src-tauri/src/llm/client.rs` / `src-tauri/src/secret.rs`）---------- */

/**
 * 保存時に API キーをどう扱うか。**「空欄＝消す」にしない**ため種類で分ける
 * （`src-tauri/src/lib.rs` の `ApiKeyUpdate` と同じ形）。
 */
export type ApiKeyUpdate =
  | { kind: "keep" }
  | { kind: "replace"; value: string }
  | { kind: "clear" };

/** 失敗の種類。画面はこれで復旧手順を出し分ける。 */
export type LlmErrorKind =
  | "unauthorized"
  | "notFound"
  | "status"
  | "unreachable"
  | "timeout"
  | "badResponse"
  | "badUrl"
  | "config";

/**
 * LLM 側の失敗。**`detail` は生の応答**（Rust 側でマスク済み）。
 *
 * これはコマンドの `Err` としてそのまま届くので、`Error` ではなくこの形で来る。
 * 判別には [`isLlmError`] を使うこと。
 */
export type LlmError = { kind: LlmErrorKind; message: string; detail: string };

export function isLlmError(value: unknown): value is LlmError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<LlmError>;
  return typeof candidate.kind === "string" && typeof candidate.message === "string";
}

export type LlmTestOutcome = {
  model: string;
  reply: string;
  elapsedMs: number;
  /** 生の応答。**マスク済み。** */
  raw: string;
};

export type LlmModelList = { models: string[]; elapsedMs: number };

/**
 * プロファイルを保存する。**新規なら `id` と参照キーは Rust 側が採番して返す。**
 * API キーの平文が通るのはこの経路だけで、行き先は資格情報マネージャーだけ。
 */
export function saveLlmProfile(
  profile: LlmProfile,
  apiKey: ApiKeyUpdate,
): Promise<LlmProfile> {
  return invoke<LlmProfile>("save_llm_profile", { profile, apiKey });
}

/** プロファイルを消す。**資格情報も一緒に消える。** */
export function deleteLlmProfile(id: string): Promise<void> {
  return invoke<void>("delete_llm_profile", { id });
}

/**
 * API キーが保存済みのプロファイルの参照キー。**値そのものは返らない。**
 * 「保存済み」の表示にだけ使う。
 */
export function llmCredentialKeys(): Promise<string[]> {
  return invoke<string[]>("llm_credential_keys");
}

/** モデル一覧（`GET {baseUrl}/models`）。**取れなくても手入力できる。** */
export function listLlmModels(id: string): Promise<LlmModelList> {
  return invoke<LlmModelList>("list_llm_models", { id });
}

/** 接続テスト（`POST {baseUrl}/chat/completions` に 1 往復）。 */
export function testLlmConnection(id: string): Promise<LlmTestOutcome> {
  return invoke<LlmTestOutcome>("test_llm_connection", { id });
}

/* ---------- レビュー skill（`src-tauri/src/llm/skill.rs`）---------- */

/** skill の出どころ。**画面に必ず出す** — どれが効いているのか読めなくなるため。 */
export type SkillOrigin = "builtIn" | "global" | "repository";

/**
 * skill が使える状態か。**使えない理由まで持つ**（消さずに理由を出すため）。
 *
 * - `untrusted` … リポジトリ内で、まだ「使う」と決めていない（**増えたファイルもここ**）
 * - `recheck`   … 一度は使うと決めたが、**そのファイルの内容が変わった**
 */
export type SkillState =
  | { kind: "ready" }
  | { kind: "untrusted" }
  | { kind: "recheck" }
  | { kind: "unreadable"; reason: string };

/**
 * 一覧の 1 件。
 *
 * **プロンプトへ渡す本文はここに来ない**（Rust 側の `usable_body` にしかない）。
 * `preview` は**決める前に読ませるためだけ**のもの。
 */
export type SkillEntry = {
  name: string;
  description: string;
  globs: string[];
  /** frontmatter の `enabled`。**ファイルの既定**であって、いまの値ではない。 */
  enabled: boolean;
  origin: SkillOrigin;
  /** ファイル名。内蔵は空。 */
  file: string;
  state: SkillState;
  /** 同名で押しのけた側の出どころ。押しのけられていなければ null。 */
  shadowedBy: SkillOrigin | null;
  /** いま使うことになっているか。 */
  inUse: boolean;
  /** `inUse` を利用者が明示的に決めたか。false ならファイルの既定のまま。 */
  decidedByUser: boolean;
  /** 本文の後ろへ足す一言。無ければ空。 */
  extra: string;
  /** いまのファイル内容のハッシュ。内蔵は空。**「使う」と決めるときに送り返す。** */
  hash: string;
  /** 決める前に読ませる本文。 */
  preview: string;
};

/** リポジトリ内 skill の数え上げ。**判断は各 `SkillEntry` が持つ。** */
export type RepoTrustStatus = {
  /** リポジトリ内に skill が 1 つでもあるか。 */
  present: boolean;
  /** 使うと決めてあるファイル数。 */
  inUse: number;
  /** まだ決めていないファイル（**あとから増えたものもここ**）。 */
  undecided: string[];
  /** 一度は決めたが内容が変わったファイル。 */
  changed: string[];
};

export type SkillCatalog = { entries: SkillEntry[]; trust: RepoTrustStatus };

/** skill を読む。`repositoryId` が null ならリポジトリ内は見ない。 */
export function loadSkills(repositoryId: string | null): Promise<SkillCatalog> {
  return invoke<SkillCatalog>("load_skills", { repositoryId });
}

/**
 * どの skill を指すか。
 * **内蔵とグローバルは名前で、リポジトリ内はファイル名で指す**（Rust 側と同じ規則）。
 */
export type SkillTarget =
  | { scope: "global"; name: string }
  | { scope: "repository"; repositoryId: string; file: string };

/**
 * skill を使う / 使わない。
 *
 * **リポジトリ内では「使う」＝ その内容を信頼すること。** `seenHash` に画面が見せていた
 * 内容のハッシュを渡す。実物と食い違えば Rust 側が断る（表示してから押すまでの間に
 * 書き換えられる隙を残さない）。
 *
 * **書き換えた状態で読み直したものが返る**（フロントで組み直さない）。
 */
export function setSkillUse(
  target: SkillTarget,
  useSkill: boolean,
  seenHash: string | null,
): Promise<SkillCatalog> {
  return invoke<SkillCatalog>("set_skill_use", { target, useSkill, seenHash });
}

/**
 * skill の本文の後ろへ足す一言を保存する。
 * **skill ファイルは書き換えない**ので、信頼のハッシュも壊れない。
 */
export function setSkillExtra(target: SkillTarget, extra: string): Promise<SkillCatalog> {
  return invoke<SkillCatalog>("set_skill_extra", { target, extra });
}

/* ---------- AI レビュー（`src-tauri/src/llm/review.rs`）---------- */

/** 指摘の重さ。**4 つ以外は Rust 側で `info` へ寄せてある。** */
export type Severity = "critical" | "major" | "minor" | "info";

export type Finding = {
  file: string;
  /** 差分の中の行。モデルが書かなければ null。 */
  line: number | null;
  severity: Severity;
  title: string;
  message: string;
};

/**
 * モデルの応答 1 つ分。**構造化できたかどうかの両方が入る。**
 *
 * `markdown` が入っているときは構造化に失敗している（DESIGN.md §10.6）。
 * **そのときも本文は捨てられていない。** `fallbackReason` を添えて出すこと。
 */
export type ReviewText = {
  summary: string;
  findings: Finding[];
  markdown: string | null;
  fallbackReason: string | null;
};

/** 使う観点。**本文は届かない** — 画面に出すのは名前と出どころだけ（CLAUDE.md §4）。 */
export type PlannedSkill = { name: string; origin: SkillOrigin };

/** 実行前に見せる 1 ファイル。**投げないものも消さずに理由付きで並ぶ。** */
export type PlannedFile = {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  tokensEstimate: number;
  /** 分けて投げる回数。**2 以上なら「hunk 分割されます」。** */
  parts: number;
  /** 投げない理由。null なら投げる。 */
  skipped: string | null;
};

/**
 * 実行前パネルの中身（DESIGN.md §10.4）。
 *
 * **見積もりも分割数も Rust 側が決める。** 同じ計算をこちらに書かないこと
 * （必ずずれる）。`blocked` はそのまま画面へ出す押せない理由。
 */
export type ReviewPlan = {
  files: PlannedFile[];
  skills: PlannedSkill[];
  tokensEstimate: number;
  blocked: string | null;
};

export type ReviewFileResult = {
  path: string;
  oldPath: string | null;
  parts: number;
  text: ReviewText | null;
  /** **このファイルだけの失敗。** 全体は止まっていない。 */
  error: LlmError | null;
  tokensEstimate: number;
  elapsedMs: number;
};

/** レビュー 1 回分。**T-23 はこれをそのまま履歴へ積む。** */
export type ReviewRun = {
  runId: string;
  profileId: string;
  model: string;
  source: DiffSource;
  skills: PlannedSkill[];
  files: ReviewFileResult[];
  summary: ReviewText | null;
  /** 失敗したファイル数。**「N 件失敗」の正はこちら**（本文ではない）。 */
  failed: number;
  cancelled: boolean;
  startedAt: number;
  elapsedMs: number;
};

/**
 * 途中経過。**`runId` で走りを見分ける** — 中止してすぐ次を始めると、
 * 前の走りの残りが後から届く。
 *
 * `index` は `ReviewPlan` の並びではなく**投げたものの通し番号**。
 * 並列度 2 以上では `delta` が混ざるので、必ずこれで振り分けること。
 */
export type ReviewProgress = { runId: string } & (
  | { kind: "started"; total: number }
  | { kind: "fileStarted"; index: number; path: string }
  | { kind: "delta"; index: number; text: string }
  | { kind: "fileDone"; index: number; result: ReviewFileResult }
  | { kind: "summaryStarted" }
  | { kind: "summaryDelta"; text: string }
  | { kind: "summaryDone"; summary: ReviewText | null }
);

/** 実行前パネルの中身を作る。**git を呼ぶので少し時間がかかる。** */
export function planReview(options: {
  repositoryId: string;
  source: DiffSource;
  profileId: string;
}): Promise<ReviewPlan> {
  return invoke<ReviewPlan>("plan_review", options);
}

/** 実行時に使ったプロファイルの控え。**`baseUrl` は redact 済み。** */
export type ProfileSnapshot = { name: string; model: string; baseUrl: string };

/**
 * 保存された 1 件（`src-tauri/src/store/reviews.rs`）。
 *
 * **保存の形とフロントが読む形が同じ。** 変換を挟まないので、
 * 履歴から開いたものと走り終えた直後のものを同じ部品で出せる。
 */
export type StoredReview = {
  schemaVersion: number;
  repositoryId: string;
  savedAt: string;
  /** 自分のファイル名。**履歴から開く鍵。** */
  file: string;
  profile: ProfileSnapshot;
  run: ReviewRun;
};

/** 履歴一覧の 1 行。**全文は持たない。** */
export type ReviewIndexRow = {
  file: string;
  savedAt: string;
  model: string;
  profileName: string;
  /** 当時の 2 点。**差分を出し直すのに使う。** */
  source: DiffSource | null;
  files: number;
  findings: number;
  failed: number;
  cancelled: boolean;
  /** 読めなかった理由。null なら読めている。**消さずに並べる。** */
  unreadable: string | null;
};

/**
 * レビューを走らせる。
 *
 * `runId` は**呼ぶ側が採番する** — 走り始める前にイベントの受け口を用意できるように。
 * `paths` は実行前パネルで**残された**ファイル。計画そのものは Rust 側が組み直す。
 *
 * **走り終えると Rust 側が保存する。** 戻り値は保存された 1 件で、
 * `file` がそのまま履歴の鍵になる（保存し忘れる経路を作らないため）。
 */
export function startReview(options: {
  runId: string;
  repositoryId: string;
  source: DiffSource;
  profileId: string;
  paths: string[];
}): Promise<StoredReview> {
  return invoke<StoredReview>("start_review", options);
}

/** レビューの履歴（新しい順）。**読めないものも理由付きで並ぶ。** */
export function listReviews(repositoryId: string): Promise<ReviewIndexRow[]> {
  return invoke<ReviewIndexRow[]>("list_reviews", { repositoryId });
}

/** 履歴 1 件の全文。 */
export function loadReview(repositoryId: string, file: string): Promise<StoredReview> {
  return invoke<StoredReview>("load_review", { repositoryId, file });
}

/**
 * レビュー結果を Markdown として書き出す。
 *
 * **`@tauri-apps/plugin-fs` は入れていない。** 要るのはこの 1 用途だけなので、
 * 行き先は保存ダイアログで選んだパスに限り、書き込みは Rust 側で行う。
 */
export function exportMarkdown(path: string, text: string): Promise<void> {
  return invoke<void>("export_markdown", { path, text });
}

/**
 * リポジトリごとの既定 LLM 接続先を覚える（DESIGN.md §10.2）。
 *
 * **実行前パネルで選んだものをそのまま覚える。** 毎回選び直させない。
 */
export function setRepositoryLlmProfile(
  repositoryId: string,
  profileId: string | null,
): Promise<void> {
  return invoke<void>("set_repository_llm_profile", { repositoryId, profileId });
}

/**
 * 実行中のレビューを止める。
 *
 * **チャンクが届いた時点で効く。** 黙り込んだ接続先が相手のときだけ、
 * 読み取りが返るまで畳まれない（fetch と同じ割り切り）。
 */
export function cancelReview(): Promise<void> {
  return invoke<void>("cancel_review");
}

const REVIEW_PROGRESS_EVENT = "review-progress";

export function onReviewProgress(
  handler: (progress: ReviewProgress) => void,
): Promise<UnlistenFn> {
  return listen<ReviewProgress>(REVIEW_PROGRESS_EVENT, (event) => handler(event.payload));
}

const SNAPSHOT_PROGRESS_EVENT = "snapshot-progress";

export function onSnapshotProgress(
  handler: (progress: SnapshotProgress) => void,
): Promise<UnlistenFn> {
  return listen<SnapshotProgress>(SNAPSHOT_PROGRESS_EVENT, (event) => handler(event.payload));
}

const FETCH_PROGRESS_EVENT = "fetch-progress";

export function onFetchProgress(
  handler: (progress: FetchProgress) => void,
): Promise<UnlistenFn> {
  return listen<FetchProgress>(FETCH_PROGRESS_EVENT, (event) => handler(event.payload));
}

const CLONE_PROGRESS_EVENT = "clone-progress";

export function onCloneProgress(
  handler: (progress: CloneProgress) => void,
): Promise<UnlistenFn> {
  return listen<CloneProgress>(CLONE_PROGRESS_EVENT, (event) => handler(event.payload));
}

const COMMAND_LOG_EVENT = "command-log";

export function onCommandLog(
  handler: (entry: CommandLogEntry) => void,
): Promise<UnlistenFn> {
  return listen<CommandLogEntry>(COMMAND_LOG_EVENT, (event) =>
    handler(event.payload),
  );
}
