import { readFileSync } from 'node:fs';
import { contrastRatio, parseTokenCss, readableForeground } from '@torch/shared/theme/contrast';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const tokens = parseTokenCss(css);
const THEMES = ['light', 'dark'] as const;

// Composite values (shadows, the scrim) are not colours in the contrast sense; every other themed value is.
const COMPOSITE = new Set(['scrim', 'shadow-popover', 'shadow-drag', 'seg-shadow']);

describe('tokens.css', () => {
  it('defines exactly the same names in both themes', () => {
    expect(Object.keys(tokens.dark).sort()).toEqual(Object.keys(tokens.light).sort());
    expect(Object.keys(tokens.light).length).toBeGreaterThan(30);
  });

  it('defines every token the components rely on', () => {
    const names = [
      'bg',
      'bg-subtle',
      'bg-elevated',
      'bg-hover',
      'bg-selected',
      'fg',
      'fg-muted',
      'fg-subtle',
      'border',
      'border-strong',
      'accent',
      'accent-fg',
      'accent-subtle',
      'accent-text',
      'danger',
      'warning',
      'success',
      'state-backlog',
      'state-unstarted',
      'state-started',
      'state-completed',
      'state-canceled',
      'priority-urgent',
      'priority-high',
      'priority-medium',
      'priority-low',
      'grid-line',
      'grid-line-strong',
      'hatch',
      'note',
    ];
    for (const theme of THEMES) for (const name of names) expect(tokens[theme][name]).toBeDefined();
  });

  it('writes every colour as a 6-digit hex', () => {
    for (const theme of THEMES) {
      for (const [name, value] of Object.entries(tokens[theme])) {
        if (COMPOSITE.has(name)) continue;
        expect(value, `${theme} --${name}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it('keeps the default accent in both themes', () => {
    for (const theme of THEMES) expect(tokens[theme].accent?.toLowerCase()).toBe('#2a5ff2');
  });

  const pairs: [string, string, number][] = [
    ['fg', 'bg', 4.5],
    ['fg-muted', 'bg', 4.5],
    ['fg', 'bg-subtle', 4.5],
    ['fg-muted', 'bg-subtle', 4.5],
    ['fg-subtle', 'bg', 3],
    ['accent-fg', 'accent', 4.5],
    ['accent', 'bg', 3],
    ['danger', 'bg', 3],
    ['success', 'bg', 3],
    ['warning', 'bg', 3],
    ['accent-text', 'bg', 4.5],
    ['accent-text', 'accent-subtle', 4.5],
    ['note', 'bg', 4.5],
    ['note', 'bg-subtle', 4.5],
    ['note', 'bg-elevated', 4.5],
  ];
  for (const theme of THEMES) {
    for (const [foreground, background, minimum] of pairs) {
      it(`${theme}: --${foreground} on --${background} is at least ${minimum}:1`, () => {
        const fg = tokens[theme][foreground];
        const bg = tokens[theme][background];
        expect(fg && bg).toBeTruthy();
        expect(contrastRatio(fg as string, bg as string)).toBeGreaterThanOrEqual(minimum);
      });
    }
  }

  it('keeps the avatar initials readable on their tint in both themes', () => {
    for (const theme of THEMES) {
      for (let n = 1; n <= 8; n++) {
        const bg = tokens[theme][`avatar-${n}-bg`];
        const fg = tokens[theme][`avatar-${n}-fg`];
        expect(bg && fg, `${theme} avatar ${n}`).toBeTruthy();
        expect(contrastRatio(fg as string, bg as string)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('has no colour literal outside the two theme blocks', () => {
    const outside = css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/:root\[data-theme=['"]\w+['"]\][^{]*\{[^}]*\}/g, '');
    expect(outside).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('a custom brand accent', () => {
  for (const accent of ['#2A5FF2', '#FFE066', '#22C55E', '#111111', '#3366ff']) {
    it(`gets a readable foreground for ${accent}`, () => {
      expect(contrastRatio(readableForeground(accent), accent)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
