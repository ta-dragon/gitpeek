/**
 * フロント側の設定状態。
 *
 * 正は `%APPDATA%\com.tatsu.givsoner\settings.json`（Rust 側 `store::settings`）。
 * ここはその写しを 1 つだけ持ち、更新のたびに保存する。
 * 状態管理ライブラリは入れず、`useSyncExternalStore` で購読する。
 */
import { useSyncExternalStore } from "react";

import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
  type SettingsRecovery,
} from "../lib/ipc";

export type SettingsSnapshot = {
  settings: Settings;
  /** 読み込みが済むまでは既定値を表示する。 */
  loaded: boolean;
  /** 壊れた settings.json を退避して既定値で起動したときだけ入る。 */
  recovered: SettingsRecovery | null;
  /** 読み込みまたは保存に失敗した理由。 */
  error: string | null;
  /** `error` がどちらで起きたか。 */
  errorKind: "load" | "save" | null;
};

let snapshot: SettingsSnapshot = {
  settings: DEFAULT_SETTINGS,
  loaded: false,
  recovered: null,
  error: null,
  errorKind: null,
};

const listeners = new Set<() => void>();

function setSnapshot(next: Partial<SettingsSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SettingsSnapshot {
  return snapshot;
}

export function useSettings(): SettingsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** 購読していない場所（イベントハンドラなど）から現在値を読む。 */
export function currentSettings(): Settings {
  return snapshot.settings;
}

let initialized = false;

/**
 * 起動時に 1 度だけ呼ぶ。StrictMode の二重実行では 2 回目を無視する。
 *
 * 読み込みに失敗しても既定値で画面は成立させる。設定が読めないことは
 * 「アプリが動かない」ではなく「保存が効かない」として扱う。
 */
export async function initSettings(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    const payload = await loadSettings();
    setSnapshot({
      settings: payload.settings,
      loaded: true,
      recovered: payload.recovered,
      error: null,
      errorKind: null,
    });
  } catch (error) {
    setSnapshot({ loaded: true, error: messageOf(error), errorKind: "load" });
  }
}

/**
 * 設定を更新して保存する。
 *
 * 保存に失敗したら値を元へ戻す。画面に見えている状態と settings.json を
 * 食い違わせないため。
 */
export async function updateSettings(
  change: (current: Settings) => Settings,
): Promise<void> {
  const previous = snapshot.settings;
  const next = change(previous);
  setSnapshot({ settings: next, error: null, errorKind: null });

  try {
    await saveSettings(next);
  } catch (error) {
    setSnapshot({ settings: previous, error: messageOf(error), errorKind: "save" });
  }
}

/** 退避の警告を閉じる。次回起動時に再発しなければ二度と出ない。 */
export function dismissSettingsNotice(): void {
  setSnapshot({ recovered: null, error: null, errorKind: null });
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : String(error);
}
