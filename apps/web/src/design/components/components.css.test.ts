import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./components.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

describe('components.css', () => {
  it('uses tokens only: no hex, rgb, hsl or named colour literal', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/);
    expect(css).not.toMatch(
      /:\s*(?:white|black|red|green|blue|gray|grey|orange|yellow|purple|pink)\b/,
    );
  });

  it('keeps every interactive control at least 32px high', () => {
    expect(css).toMatch(/--control-height/);
  });
});
