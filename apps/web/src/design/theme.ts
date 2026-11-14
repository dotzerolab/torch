import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** No product name in the key: a white-label deployment shares the code, not the brand. */
export const THEME_STORAGE_KEY = 'ui-theme';

const PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];
const DARK_QUERY = '(prefers-color-scheme: dark)';

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined; // storage blocked: the choice lasts for the page only
  }
}

/** The stored choice; a missing, unreadable or unknown value means follow the system. */
export function getThemePreference(
  storage: Storage | undefined = browserStorage(),
): ThemePreference {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return PREFERENCES.includes(value as ThemePreference) ? (value as ThemePreference) : 'system';
  } catch {
    return 'system';
  }
}

/** A stored light or dark wins; `system` follows the operating system. Mirrored by public/theme-init.js. */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return prefersDark ? 'dark' : 'light';
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

const subscribers = new Set<() => void>();
let stopFollowingSystem: (() => void) | undefined;
let current: { preference: ThemePreference; resolved: ResolvedTheme } | undefined;

function notify() {
  current = undefined;
  for (const subscriber of subscribers) subscriber();
}

/**
 * Puts the resolved theme on the root element (`data-theme` and `color-scheme`) and, while the preference is
 * `system`, keeps it in step with the operating system.
 */
export function applyTheme(root: HTMLElement = document.documentElement): ResolvedTheme {
  stopFollowingSystem?.();
  stopFollowingSystem = undefined;

  const preference = getThemePreference();
  const resolved = resolveTheme(preference, systemPrefersDark());
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;

  if (preference === 'system' && typeof window.matchMedia === 'function') {
    const query = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      applyTheme(root);
      notify();
    };
    query.addEventListener('change', onChange);
    stopFollowingSystem = () => query.removeEventListener('change', onChange);
  }
  return resolved;
}

/** Stores the choice, then applies it. */
export function setThemePreference(
  preference: ThemePreference,
  storage: Storage | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // The choice still applies for this page.
  }
  applyTheme();
  notify();
}

function snapshot() {
  const preference = getThemePreference();
  const resolved = resolveTheme(preference, systemPrefersDark());
  if (current?.preference !== preference || current.resolved !== resolved) {
    current = { preference, resolved };
  }
  return current;
}

function subscribe(listener: () => void) {
  subscribers.add(listener);
  // Another tab changed the choice.
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) {
      applyTheme();
      notify();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    subscribers.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The stored preference, the theme it resolves to, and a setter that stores and applies a new choice. */
export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
} {
  const { preference, resolved } = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { preference, resolved, setPreference: setThemePreference };
}
