import { useCallback, useEffect } from "react";

import type { ThemePreference } from "../lib/ipc";
import { currentSettings, updateSettings, useSettings } from "../store/settings";

export type { ThemePreference };

/**
 * テーマの既定は OS 追従（docs/DESIGN.md §6.1）。
 *
 * 保存先は `settings.json` の `ui.theme`。Phase 0 で暫定的に使っていた
 * localStorage の値は、初回だけ設定へ引き継いでからキーを消す。
 */
const LEGACY_STORAGE_KEY = "givsoner.theme";

function takeLegacyTheme(): ThemePreference | null {
  try {
    const value = localStorage.getItem(LEGACY_STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") {
      return value;
    }
  } catch {
    // localStorage が使えない環境では移行するものが無いのと同じ。
  }
  return null;
}

export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const { settings, loaded } = useSettings();
  const theme = settings.ui.theme;

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", theme);
    }
  }, [theme]);

  const setTheme = useCallback((next: ThemePreference) => {
    void updateSettings((current) => ({
      ...current,
      ui: { ...current.ui, theme: next },
    }));
  }, []);

  // 設定を読み終えてから 1 度だけ移行する。既に設定側で選んであるなら触らない。
  useEffect(() => {
    if (!loaded) return;
    const legacy = takeLegacyTheme();
    if (legacy && legacy !== "system" && currentSettings().ui.theme === "system") {
      setTheme(legacy);
    }
  }, [loaded, setTheme]);

  return [theme, setTheme];
}
