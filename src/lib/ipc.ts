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

const COMMAND_LOG_EVENT = "command-log";

export function onCommandLog(
  handler: (entry: CommandLogEntry) => void,
): Promise<UnlistenFn> {
  return listen<CommandLogEntry>(COMMAND_LOG_EVENT, (event) =>
    handler(event.payload),
  );
}
