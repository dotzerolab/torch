// WCAG 2.x contrast maths for the theme tokens and for a brand's accent colour.

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Near-black used as the text colour on a light accent. */
const DARK_FOREGROUND = '#0b0b0f';
const LIGHT_FOREGROUND = '#ffffff';

function channels(colour: string): [number, number, number] {
  if (typeof colour !== 'string' || !HEX.test(colour)) throw new Error('invalid colour');
  const digits =
    colour.length === 4
      ? [...colour.slice(1)].map((digit) => digit + digit).join('')
      : colour.slice(1);
  return [0, 2, 4].map((start) => Number.parseInt(digits.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance(colour: string): number {
  const [red, green, blue] = channels(colour).map((value) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG contrast ratio (1 to 21) of two hex colours (`#rgb` or `#rrggbb`), in either order. */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The text colour, white or near-black, that reads better on `background`. */
export function readableForeground(background: string): '#ffffff' | '#0b0b0f' {
  return contrastRatio(LIGHT_FOREGROUND, background) >= contrastRatio(DARK_FOREGROUND, background)
    ? LIGHT_FOREGROUND
    : DARK_FOREGROUND;
}

const THEME_BLOCK = {
  light: /(?:^|\})\s*[^{}]*\[data-theme=['"]light['"]\][^{}]*\{([^}]*)\}/,
  dark: /(?:^|\})\s*[^{}]*\[data-theme=['"]dark['"]\][^{}]*\{([^}]*)\}/,
} as const;

function declarations(body: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const declaration of body.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const name = declaration.slice(0, colon).trim();
    if (!name.startsWith('--')) continue;
    tokens[name.slice(2)] = declaration
      .slice(colon + 1)
      .replace(/\s+/g, ' ')
      .trim();
  }
  return tokens;
}

/**
 * The custom properties of the `[data-theme='light']` and `[data-theme='dark']` blocks of a stylesheet, keyed
 * without the leading dashes (`--bg-subtle` is `bg-subtle`). Blocks for other selectors are left out.
 */
export function parseTokenCss(css: string): Record<'light' | 'dark', Record<string, string>> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return {
    light: declarations(THEME_BLOCK.light.exec(text)?.[1] ?? ''),
    dark: declarations(THEME_BLOCK.dark.exec(text)?.[1] ?? ''),
  };
}
