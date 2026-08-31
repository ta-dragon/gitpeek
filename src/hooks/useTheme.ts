import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

/**
 * テーマの既定は OS 追従（docs/DESIGN.md §6.1）。
 *
 * 保存先は暫定的に localStorage。Phase 9 で settings.json (`ui.theme`) へ移す。
 */
const STORAGE_KEY = "givsoner.theme";

function readStored(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") {
      return value;
    }
  } catch {
    // プライベートウィンドウ等で localStorage が使えない場合は既定へ倒す。
  }
  return "system";
}

export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const [theme, setThemeState] = useState<ThemePreference>(readStored);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", theme);
    }
  }, [theme]);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 保存できなくても表示は成立する。
    }
  }, []);

  return [theme, setTheme];
}
