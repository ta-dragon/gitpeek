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
  /** 検出するだけ。アプリからは削除しない。 */
  indexLockPresent: boolean;
  error: string | null;
};

/** 登録内容に実際の状態を添えたもの。`probe` が null ならパスが消えている。 */
export type RepositoryEntry = RepositorySettings & {
  probe: RepositoryProbe | null;
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
export function loadChangedFiles(
  repositoryId: string,
  sha: string,
  parent: string | null,
): Promise<FileChange[]> {
  return invoke<FileChange[]>("load_changed_files", { repositoryId, sha, parent });
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

/** コンテキスト行の選択肢。「すべて」は十分大きな `-U` で代用する。 */
export const ALL_CONTEXT_LINES = 1_000_000;

/**
 * ファイル 1 つの差分を取る。
 *
 * **リネームでは `oldPath` を必ず渡すこと。** 新しいパスだけを渡すと git は
 * リネームを検出できず、**全行が追加された新規ファイル**として返す。
 * `parent` は `loadChangedFiles` と同じく **null がルートコミット**。
 */
export function loadFileDiff(options: {
  repositoryId: string;
  sha: string;
  parent: string | null;
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
 * T-20 で使う。T-01 では常に空配列。
 * **API キーはここに持たない。** 実体は Windows 資格情報マネージャーにあり、
 * ここにあるのは参照キーだけ（CLAUDE.md §4）。
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

const SNAPSHOT_PROGRESS_EVENT = "snapshot-progress";

export function onSnapshotProgress(
  handler: (progress: SnapshotProgress) => void,
): Promise<UnlistenFn> {
  return listen<SnapshotProgress>(SNAPSHOT_PROGRESS_EVENT, (event) => handler(event.payload));
}

const COMMAND_LOG_EVENT = "command-log";

export function onCommandLog(
  handler: (entry: CommandLogEntry) => void,
): Promise<UnlistenFn> {
  return listen<CommandLogEntry>(COMMAND_LOG_EVENT, (event) =>
    handler(event.payload),
  );
}
