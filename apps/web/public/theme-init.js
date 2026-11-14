// Runs before the first paint (a blocking script in <head>), so the page never shows the wrong theme.
// Keep the logic identical to resolveTheme() in src/design/theme.ts; theme.test.ts compares the two.
// A stored 'light' or 'dark' wins; anything else (nothing, 'system', junk) follows the system setting.
(() => {
  let stored = null;
  try {
    stored = window.localStorage.getItem('ui-theme');
  } catch {
    stored = null;
  }
  const dark =
    stored === 'dark' ||
    (stored !== 'light' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  const theme = dark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
})();
