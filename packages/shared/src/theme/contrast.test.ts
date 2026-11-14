import { describe, expect, it } from 'vitest';
import { contrastRatio, parseTokenCss, readableForeground } from './contrast.ts';

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for identical colours', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });

  it('matches the WCAG reference for #777777 on white', () => {
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });

  it('does not depend on the order of the two colours', () => {
    expect(contrastRatio('#ffffff', '#777777')).toBeCloseTo(
      contrastRatio('#777777', '#ffffff'),
      10,
    );
  });

  it('accepts the #rgb shorthand', () => {
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFF', '#000000')).toBeCloseTo(21, 5);
  });

  it('rejects anything that is not a hex colour', () => {
    expect(() => contrastRatio('red', '#fff')).toThrow(new Error('invalid colour'));
    expect(() => contrastRatio('#12345', '#fff')).toThrow(new Error('invalid colour'));
    expect(() => contrastRatio('#fff', 'rgb(0,0,0)')).toThrow(new Error('invalid colour'));
  });
});

describe('readableForeground', () => {
  it('picks white on the default accent and near-black on a pale one', () => {
    expect(readableForeground('#2A5FF2')).toBe('#ffffff');
    expect(readableForeground('#FFE066')).toBe('#0b0b0f');
  });

  it('never returns a pairing below 4.5 for any colour', () => {
    for (const background of ['#22C55E', '#111111', '#ffffff', '#000000', '#808080', '#767676']) {
      const foreground = readableForeground(background);
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('throws on invalid input', () => {
    expect(() => readableForeground('blue')).toThrow(new Error('invalid colour'));
  });
});

describe('parseTokenCss', () => {
  const css = `
    :root { --space-1: 4px; }
    /* the light theme */
    :root[data-theme='light'] {
      --bg: #ffffff;
      --fg: #111111; /* text */
    }
    :root[data-theme='dark'] {
      --bg: #000000;
      --fg: #eeeeee;
      --shadow-popover: 0 1px 2px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.04);
    }
  `;

  it('reads both theme blocks and strips the leading dashes from the names', () => {
    const tokens = parseTokenCss(css);
    expect(tokens.light).toEqual({ bg: '#ffffff', fg: '#111111' });
    expect(tokens.dark.bg).toBe('#000000');
    expect(tokens.dark.fg).toBe('#eeeeee');
  });

  it('keeps multi-part values whole and leaves theme-independent blocks out', () => {
    const tokens = parseTokenCss(css);
    expect(tokens.dark['shadow-popover']).toBe(
      '0 1px 2px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.04)',
    );
    expect(tokens.light['space-1']).toBeUndefined();
  });

  it('also reads a block whose selector lists a fallback after the theme selector', () => {
    const tokens = parseTokenCss(
      ":root[data-theme='light'], :root:not([data-theme]) { --bg: #fff; }\n:root[data-theme='dark'] { --bg: #000; }",
    );
    expect(tokens.light.bg).toBe('#fff');
  });
});
