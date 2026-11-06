import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'issue-triage:theme';
const ORDER: ThemePreference[] = ['system', 'light', 'dark'];

function stored(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Light, dark, or whatever the system prefers (the default). The choice is applied as
 * `data-theme` on <html>, which the CSS tokens key off; "system" removes it and lets
 * `prefers-color-scheme` decide.
 */
export function useTheme(): { theme: ThemePreference; cycle: () => void } {
  const [theme, setTheme] = useState<ThemePreference>(stored);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = theme;
    }
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this visit.
    }
  }, [theme]);

  const cycle = useCallback(() => {
    setTheme((current) => ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? 'system');
  }, []);
  return { theme, cycle };
}
