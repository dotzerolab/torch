// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyTheme,
  getThemePreference,
  resolveTheme,
  setThemePreference,
  THEME_STORAGE_KEY,
} from './theme.ts';

type Listener = (event: { matches: boolean }) => void;

/** A matchMedia stand-in whose dark/light answer can be flipped by the test. */
function stubMatchMedia(initialDark: boolean) {
  const listeners = new Set<Listener>();
  const state = { dark: initialDark };
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes('dark') ? state.dark : false;
    },
    media: query,
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
  return {
    set(dark: boolean) {
      state.dark = dark;
      for (const listener of [...listeners]) listener({ matches: dark });
    },
    listenerCount: () => listeners.size,
  };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
});
afterEach(() => localStorage.clear());

describe('getThemePreference', () => {
  it('defaults to system and ignores junk', () => {
    expect(getThemePreference()).toBe('system');
    localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    expect(getThemePreference()).toBe('system');
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(getThemePreference()).toBe('dark');
  });

  it('survives a storage that throws', () => {
    const broken = {
      getItem() {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(getThemePreference(broken)).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('follows the system only for the system preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('sets data-theme and color-scheme on the root', () => {
    stubMatchMedia(true);
    expect(applyTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('lets a stored choice beat the system setting', () => {
    stubMatchMedia(true);
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(applyTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('follows the system while the preference is system', () => {
    const media = stubMatchMedia(false);
    applyTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
    media.set(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('ignores system changes after an explicit choice and stops listening', () => {
    const media = stubMatchMedia(false);
    setThemePreference('light');
    media.set(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(media.listenerCount()).toBe(0);
  });

  it('does not stack listeners when applied twice', () => {
    const media = stubMatchMedia(false);
    applyTheme();
    applyTheme();
    expect(media.listenerCount()).toBe(1);
  });
});

describe('setThemePreference', () => {
  it('stores the choice and applies it', () => {
    stubMatchMedia(false);
    setThemePreference('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('theme-init.js', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = readFileSync(join(here, '../../public/theme-init.js'), 'utf8');
  const run = () => new Function(script)();

  it('agrees with resolveTheme for every stored value and system setting', () => {
    for (const stored of [null, 'light', 'dark', 'system', 'junk']) {
      for (const prefersDark of [true, false]) {
        localStorage.clear();
        if (stored !== null) localStorage.setItem(THEME_STORAGE_KEY, stored);
        document.documentElement.removeAttribute('data-theme');
        stubMatchMedia(prefersDark);
        run();
        const preference = getThemePreference();
        expect(document.documentElement.dataset.theme, `${stored} / dark=${prefersDark}`).toBe(
          resolveTheme(preference, prefersDark),
        );
        expect(document.documentElement.style.colorScheme).toBe(
          document.documentElement.dataset.theme,
        );
      }
    }
  });

  it('makes no network request', () => {
    expect(script).not.toMatch(/fetch|XMLHttpRequest|import\(|https?:/);
  });
});
