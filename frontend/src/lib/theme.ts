export type ThemeName = 'light' | 'dark';

const STORAGE_KEY = 'hermes_theme';

/** Fired whenever the theme changes so components other than the toggler (e.g. the
 * command palette's "Toggle theme" action) can keep their own state in sync. */
export const THEME_CHANGE_EVENT = 'hermes:theme-changed';

export function getTheme(): ThemeName {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function setTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: theme }));
}

export function toggleTheme(): ThemeName {
  const next: ThemeName = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
