// Builds every logo file from code: the symbol on a golden-ratio grid, the wordmark as outlined paths.
//   node docs/brand/build.ts [outDir]     default: apps/web/public/brand
//   node docs/brand/build.ts --contrast   print the WCAG table used in BRAND.md
//
// One scale: A = flame height = 100 units, every length is A / phi^n (phi = 1.618). The flame is made of circular
// arcs only, so the construction (circles and lines) is exactly the shape. Two cuts share the grid:
//   logo   two tongues (main + lick), for renders taller than 32 px
//   small  one tongue, heavier caret, for renders of 32 px or less
// The wordmark is Orbitron SemiBold (SIL OFL 1.1) converted to outlines, integer font units, no font is loaded.
// PNGs are drawn from the SVGs with Chromium (Playwright, a dev dependency of apps/web).
// Public files carry no product name and no accessible name: the page or the `alt` text gives it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PHI = (1 + Math.sqrt(5)) / 2;
const p = (n: number) => 100 / PHI ** n; // A / phi^n with A = 100

// ---- palette --------------------------------------------------------------------------------------------------

type Colours = { left: string; right: string; caret: string; ink: string };
const LIGHT: Colours = { left: '#1A2FB5', right: '#2F6BFF', caret: '#DDF6FF', ink: '#080A11' };
const DARK: Colours = { left: '#3552E8', right: '#4F82FF', caret: '#E8F8FF', ink: '#F6FAFF' };
const TILE = '#090D22'; // icon tile: the dark palette on a night-blue square
const SURFACE = { light: '#F6FAFF', dark: '#080A11' };

// ---- geometry -------------------------------------------------------------------------------------------------

type Pt = [number, number];
type Opts = {
  WH: number; // flame height : belly width
  tipX: number; // x of the main tip, in belly radii
  rhoR: number; // concave flank arc
  single: boolean; // one tongue (small cut)
  lickY: number; // y of the lick tip, in A
  notch: Pt; // [x in belly radii, y in A]
  rhoN: number; // lick scoop
  rhoT: number; // tongue edge
  slitK: number; // slit slope dx/dy
  shift: number; // the right half moves (+shift, -shift)
  caretW: number; // caret path width
  caretS: number; // caret stroke
  caretY: number; // caret visible centre, in belly radii below the belly centre
  over: number; // optical overshoot of the round shapes
};
const LICK = { single: false, lickY: 0.27, notch: [-1 / PHI ** 3, 1 / PHI ** 2] as Pt, rhoN: p(4), rhoT: p(1) };
const CUTS: Record<'logo' | 'small', Opts> = {
  logo: {
    WH: PHI, tipX: 1 / PHI ** 4, rhoR: p(2), ...LICK,
    slitK: 1 / PHI ** 4, shift: p(6), caretW: p(2.5), caretS: p(4), caretY: -0.1, over: 1.2,
  },
  small: {
    WH: PHI, tipX: 1 / PHI ** 4, rhoR: p(2), single: true, lickY: 0, notch: [0, 0], rhoN: 0, rhoT: 0,
    slitK: 1 / PHI ** 3, shift: p(5), caretW: p(3), caretS: p(4), caretY: 0, over: 1.2,
  },
};

const num = (v: number, d = 2) => (Math.abs(v) < 0.5 * 10 ** -d ? '0' : String(+v.toFixed(d)));
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
const unit = (a: Pt): Pt => mul(a, 1 / len(a));

// centre of the circle of radius r through P and Q; side +1 = centre to the right of P->Q on screen (y down)
function centreFor(P: Pt, Q: Pt, r: number, side: 1 | -1): Pt {
  const m = mul(add(P, Q), 0.5);
  const c = sub(Q, P);
  const h = Math.sqrt(Math.max(0, r * r - (len(c) / 2) ** 2));
  return add(m, mul(unit([-c[1], c[0]]), side * h));
}
// minor arc P->Q around C: 1 when the angle grows (clockwise on screen)
function sweepOf(C: Pt, P: Pt, Q: Pt): 0 | 1 {
  let d = Math.atan2(Q[1] - C[1], Q[0] - C[0]) - Math.atan2(P[1] - C[1], P[0] - C[0]);
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d > 0 ? 1 : 0;
}
// point U on circle (C1, R1) where the tangent circle of radius rho (centre outside, on the ray C1->U) passes through T
function tangentJoin(C1: Pt, R1: number, rho: number, T: Pt, pick: 'left' | 'right') {
  const t = sub(T, C1);
  const d = len(t);
  const K = (d * d + (R1 + rho) ** 2 - rho * rho) / (2 * (R1 + rho));
  const a = Math.atan2(t[1], t[0]);
  const b = Math.acos(Math.max(-1, Math.min(1, K / d)));
  const us = [a + b, a - b].map((th): Pt => [Math.cos(th), Math.sin(th)]).sort((u, v) => u[0] - v[0]);
  const u = (pick === 'right' ? us[1] : us[0]) as Pt;
  return { U: add(C1, mul(u, R1)), C: add(C1, mul(u, R1 + rho)) };
}

type Seg = { C: Pt; r: number; P: Pt; Q: Pt; large: 0 | 1; sweep: 0 | 1 };
const seg = (C: Pt, r: number, P: Pt, Q: Pt, large: 0 | 1, sweep: 0 | 1): Seg => ({ C, r, P, Q, large, sweep });

function bridge(o: Opts) {
  const A = 100;
  const W = A / o.WH;
  const R = W / 2;
  const Rb = R + o.over / 2;
  const O: Pt = [0, A - R - o.over / 2]; // belly centre
  const T: Pt = [o.tipX * R, 0];
  const rf = W; // flank arcs: radius = belly width, centred on the opposite widest point
  const segs: Seg[] = [];
  const Cr: Pt = [Rb - rf, O[1]];
  const jr = tangentJoin(Cr, rf, o.rhoR, T, 'right');
  segs.push(seg(jr.C, o.rhoR, T, jr.U, 0, sweepOf(jr.C, T, jr.U))); // tip -> inflection (concave)
  segs.push(seg(Cr, rf, jr.U, [Rb, O[1]], 0, sweepOf(Cr, jr.U, [Rb, O[1]]))); // inflection -> widest point
  segs.push(seg(O, Rb, [Rb, O[1]], [-Rb, O[1]], 0, 1)); // lower half circle, clockwise
  const Cl: Pt = [-Rb + rf, O[1]];
  const Jl: Pt = [-Rb, O[1]];
  if (o.single) {
    const jl = tangentJoin(Cl, rf, o.rhoR, T, 'left');
    segs.push(seg(Cl, rf, Jl, jl.U, 0, sweepOf(Cl, Jl, jl.U)));
    segs.push(seg(jl.C, o.rhoR, jl.U, T, 0, sweepOf(jl.C, jl.U, T)));
  } else {
    const y = o.lickY * A;
    const L: Pt = [Cl[0] - Math.sqrt(rf * rf - (y - O[1]) ** 2), y]; // lick tip: the flank circle at height lickY
    const N: Pt = [o.notch[0] * R, o.notch[1] * A];
    const cN = centreFor(L, N, o.rhoN, 1);
    const cT = centreFor(N, T, o.rhoT, 1);
    segs.push(seg(Cl, rf, Jl, L, 0, sweepOf(Cl, Jl, L)));
    segs.push(seg(cN, o.rhoN, L, N, 0, sweepOf(cN, L, N)));
    segs.push(seg(cT, o.rhoT, N, T, 0, sweepOf(cT, N, T)));
  }
  const d =
    `M${num(T[0])} ${num(T[1])}` +
    segs.map((s) => `A${num(s.r)} ${num(s.r)} 0 ${s.large} ${s.sweep} ${num(s.Q[0])} ${num(s.Q[1])}`).join('') +
    'Z';
  // the slit passes through the belly centre and leans k = dx/dy (top to the right)
  const k = o.slitK;
  const big = 400;
  const xs = (y: number) => -k * (y - O[1]);
  const left = `M${-big} ${-big}H${num(xs(-big))}L${num(xs(big))} ${big}H${-big}Z`;
  const right = `M${big} ${-big}H${num(xs(-big))}L${num(xs(big))} ${big}H${big}Z`;
  const gapH = o.shift * (1 - k);
  // caret: 45 degree legs, apex on the slit centre line, visible centre on the belly centre
  const ya = O[1] + o.caretY * R - o.caretW / 4;
  const xa = xs(ya) + gapH / 2;
  const caret = `M${num(xa - o.caretW / 2)} ${num(ya + o.caretW / 2)}L${num(xa)} ${num(ya)}L${num(xa + o.caretW / 2)} ${num(ya + o.caretW / 2)}`;
  return { o, W, R, Rb, O, segs, d, left, right, shift: [o.shift, -o.shift] as Pt, caret, apex: [xa, ya] as Pt, xs };
}
type Bridge = ReturnType<typeof bridge>;

function sampleArc(s: Seg, n = 64): Pt[] {
  const a0 = Math.atan2(s.P[1] - s.C[1], s.P[0] - s.C[0]);
  let d = Math.atan2(s.Q[1] - s.C[1], s.Q[0] - s.C[0]) - a0;
  if (s.sweep) while (d <= 0) d += 2 * Math.PI;
  else while (d >= 0) d -= 2 * Math.PI;
  if (!s.large && Math.abs(d) > Math.PI) d += d > 0 ? -2 * Math.PI : 2 * Math.PI;
  return Array.from({ length: n + 1 }, (_, i): Pt => {
    const a = a0 + (d * i) / n;
    return [s.C[0] + s.r * Math.cos(a), s.C[1] + s.r * Math.sin(a)];
  });
}
// every visible outline point: the left half as drawn, the right half after its lift, plus the caret with its stroke
function inkPoints(g: Bridge): Pt[] {
  const pts: Pt[] = [];
  for (const [x, y] of g.segs.flatMap((s) => sampleArc(s))) {
    if (x <= g.xs(y)) pts.push([x, y]);
    if (x >= g.xs(y)) pts.push([x + g.shift[0], y + g.shift[1]]);
  }
  const sw = g.o.caretS / 2;
  const [xa, ya] = g.apex;
  const w = g.o.caretW;
  pts.push([xa - w / 2 - sw, ya + w / 2 + sw], [xa + w / 2 + sw, ya + w / 2 + sw], [xa, ya - sw]);
  return pts;
}
// the mark fitted into the 64 box with a margin of 2, centred on its visible extent
function fit(g: Bridge, box = 64, margin = 2) {
  const pts = inkPoints(g);
  const xsAll = pts.map((q) => q[0]);
  const ysAll = pts.map((q) => q[1]);
  const [x0, x1, y0, y1] = [Math.min(...xsAll), Math.max(...xsAll), Math.min(...ysAll), Math.max(...ysAll)];
  const k = Math.min((box - 2 * margin) / (x1 - x0), (box - 2 * margin) / (y1 - y0));
  return { k, tx: box / 2 - ((x0 + x1) / 2) * k, ty: box / 2 - ((y0 + y1) / 2) * k, bbox: [x0, y0, x1, y1] as const };
}
// farthest ink point from the centre of the 64 box once the mark is scaled by s about that centre
function reach(cut: 'logo' | 'small', s: number): number {
  const g = bridge(CUTS[cut]);
  const t = fit(g);
  return Math.max(...inkPoints(g).map(([x, y]) => Math.hypot(x * t.k + t.tx - 32, y * t.k + t.ty - 32))) * s;
}

// the mark, in the 64 box. `id` keeps the clip paths of several marks in one file apart.
function mark(cut: 'logo' | 'small', c: Colours, id = ''): string {
  const g = bridge(CUTS[cut]);
  const t = fit(g);
  const half = (side: 'l' | 'r', fill: string, shifted: boolean) => {
    const path = `<path clip-path="url(#${id}${side})" fill="${fill}" d="${g.d}"/>`;
    return shifted ? `<g transform="translate(${num(g.shift[0])} ${num(g.shift[1])})">${path}</g>` : path;
  };
  return (
    `<g transform="translate(${num(t.tx)} ${num(t.ty)}) scale(${num(t.k, 4)})">` +
    `<defs><clipPath id="${id}l"><path d="${g.left}"/></clipPath><clipPath id="${id}r"><path d="${g.right}"/></clipPath></defs>` +
    `${half('l', c.left, false)}${half('r', c.right, true)}` +
    `<path d="${g.caret}" fill="none" stroke="${c.caret}" stroke-width="${num(g.o.caretS)}" stroke-linecap="round" stroke-linejoin="round"/></g>`
  );
}

// ---- wordmark: Orbitron SemiBold "Torch", y down, baseline 0, integer font units (1000 per em) ----------------------

const ORBITRON = {
  cap: 720,
  letters: [
    { adv: 759, d: 'M320 0V-599H20V-720H740V-599H441V0Z', b: [20, 0, 740, 720] },
    { adv: 692, d: 'M185 0Q148 0 118 -18Q88 -37 69 -67Q51 -97 51 -134V-446Q51 -483 69 -513Q88 -543 118 -562Q148 -580 185 -580H506Q544 -580 574 -562Q604 -543 622 -513Q640 -483 640 -446V-134Q640 -97 622 -67Q604 -37 574 -18Q544 0 506 0H185ZM189 -119H502Q510 -119 515 -125Q521 -130 521 -138V-442Q521 -450 515 -455Q510 -461 502 -461H189Q181 -461 176 -455Q170 -450 170 -442V-138Q170 -130 176 -125Q181 -119 189 -119Z', b: [51, 0, 640, 580] },
    { adv: 519, d: 'M52 0V-446Q52 -483 70 -513Q89 -543 119 -562Q150 -580 186 -580H509V-461H190Q182 -461 177 -455Q171 -450 171 -442V0Z', b: [52, 0, 509, 580] },
    { adv: 695, d: 'M185 0Q148 0 118 -18Q88 -37 69 -67Q51 -97 51 -134V-446Q51 -483 69 -513Q88 -543 118 -562Q148 -580 185 -580H639V-461H189Q181 -461 176 -455Q170 -450 170 -442V-138Q170 -130 176 -125Q181 -119 189 -119H640V0H185Z', b: [51, 0, 640, 580] },
    { adv: 668, d: 'M54 0V-770H173V-580H510Q546 -580 576 -562Q607 -543 625 -513Q643 -483 643 -446V0H524V-442Q524 -450 519 -455Q513 -461 506 -461H192Q185 -461 179 -455Q173 -450 173 -442V0Z', b: [54, 0, 643, 770] },
  ],
};
const word = (() => {
  let x = 0;
  const parts = ORBITRON.letters.map((l) => {
    const at = x;
    x += l.adv;
    return { at, d: l.d };
  });
  const last = ORBITRON.letters[ORBITRON.letters.length - 1];
  const xmin = ORBITRON.letters[0]?.b[0] ?? 0;
  const xmax = (parts[parts.length - 1]?.at ?? 0) + (last?.b[2] ?? 0);
  const top = Math.max(...ORBITRON.letters.map((l) => l.b[3] ?? 0)); // the h rises above the caps
  return { parts, xmin, width: xmax - xmin, top };
})();
// the wordmark placed with its ink left edge at x, baseline at y, scaled s (font units -> px)
function wordmark(x: number, y: number, s: number, fill: string): string {
  const paths = word.parts.map((q) => `<path transform="translate(${q.at} 0)" d="${q.d}"/>`).join('');
  return `<g transform="translate(${num(x - word.xmin * s)} ${num(y)}) scale(${num(s, 5)})" fill="${fill}">${paths}</g>`;
}

// ---- lockups: cap height = belly width (A/phi) horizontal, A/phi^2 stacked; the gap is A/phi^3 ---------------------

const svgOpen = (w: number, h: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(w, 1)} ${num(h, 1)}" width="${num(w, 1)}" height="${num(h, 1)}" aria-hidden="true">`;

function horizontal(cut: 'logo' | 'small', c: Colours): string {
  const g = bridge(CUTS[cut]);
  const t = fit(g);
  const s = (2 * g.Rb * t.k) / ORBITRON.cap; // cap height = belly width
  const base = (g.O[1] + g.Rb) * t.k + t.ty; // baseline on the flame bottom
  const x0 = t.tx + t.bbox[2] * t.k + p(3) * t.k;
  const w = x0 + word.width * s + 2;
  return `${svgOpen(w, 64)}${mark(cut, c)}${wordmark(x0, base, s, c.ink)}</svg>\n`;
}
function stacked(c: Colours): string {
  const g = bridge(CUTS.logo);
  const t = fit(g);
  const capPx = p(2) * t.k; // cap height = A/phi^2 (belly width / phi)
  const s = capPx / ORBITRON.cap;
  const w = word.width * s + 4;
  const markBottom = t.ty + t.bbox[3] * t.k;
  const top = markBottom + p(3) * t.k;
  const h = top + capPx + 2;
  const markX = w / 2 - 32; // the mark's 64 box is centred, its visible extent already centres inside it
  return `${svgOpen(w, h)}<g transform="translate(${num(markX)} 0)">${mark('logo', c)}</g>${wordmark(2, top + capPx, s, c.ink)}</svg>\n`;
}
function wordmarkOnly(c: Colours): string {
  const w = word.width;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${-word.top} ${w} ${word.top}" width="${num(w / 10, 1)}" height="${num(word.top / 10, 1)}" aria-hidden="true"><g transform="translate(${-word.xmin} 0)" fill="${c.ink}">${word.parts.map((q) => `<path transform="translate(${q.at} 0)" d="${q.d}"/>`).join('')}</g></svg>\n`;
}
function symbol(cut: 'logo' | 'small', c: Colours): string {
  return `${svgOpen(64, 64)}${mark(cut, c)}</svg>\n`;
}

// ---- icon tiles -----------------------------------------------------------------------------------------------

type Tile = { cut: 'logo' | 'small'; radius: number; scale: number };
const RADIUS = 64 / PHI ** 3; // tile corner radius = tile / phi^3
function tile({ cut, radius, scale }: Tile): string {
  const o = num(32 * (1 - scale));
  return (
    `${svgOpen(64, 64)}<rect width="64" height="64"${radius ? ` rx="${num(radius)}"` : ''} fill="${TILE}"/>` +
    `<g transform="translate(${o} ${o}) scale(${scale})">${mark(cut, DARK)}</g></svg>\n`
  );
}

// ---- contrast (WCAG 2.2) --------------------------------------------------------------------------------------

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
function contrastTable(): string {
  const rows: [string, string, string, number][] = [
    ['Light', 'Wordmark and text', `${LIGHT.ink}|${SURFACE.light}`, 4.5],
    ['Light', 'Left half on the surface', `${LIGHT.left}|${SURFACE.light}`, 3],
    ['Light', 'Right half on the surface', `${LIGHT.right}|${SURFACE.light}`, 3],
    ['Light', 'Brand accent on the surface', `#2A5FF2|${SURFACE.light}`, 3],
    ['Light', 'White text on the brand accent', `#FFFFFF|#2A5FF2`, 4.5],
    ['Light', 'Caret on the left half', `${LIGHT.caret}|${LIGHT.left}`, 3],
    ['Light', 'Caret on the right half', `${LIGHT.caret}|${LIGHT.right}`, 3],
    ['Light', 'Right half against the left half (the slit separates them)', `${LIGHT.right}|${LIGHT.left}`, 0],
    ['Dark', 'Wordmark and text', `${DARK.ink}|${SURFACE.dark}`, 4.5],
    ['Dark', 'Left half on the surface', `${DARK.left}|${SURFACE.dark}`, 3],
    ['Dark', 'Right half on the surface', `${DARK.right}|${SURFACE.dark}`, 3],
    ['Dark', 'Brand accent on the surface', `#2A5FF2|${SURFACE.dark}`, 3],
    ['Dark', 'Caret on the left half', `${DARK.caret}|${DARK.left}`, 3],
    ['Dark', 'Caret on the right half', `${DARK.caret}|${DARK.right}`, 3],
    ['Dark', 'Right half against the left half (the slit separates them)', `${DARK.right}|${DARK.left}`, 0],
    ['Tile', 'Left half on the icon tile', `${DARK.left}|${TILE}`, 3],
    ['Tile', 'Right half on the icon tile', `${DARK.right}|${TILE}`, 3],
    ['Tile', 'Caret on the icon tile', `${DARK.caret}|${TILE}`, 3],
  ];
  const lines = ['| Mode | Pair | Foreground | Background | Ratio | Needs |', '|---|---|---|---|---|---|'];
  for (const [mode, use, pair, min] of rows) {
    const [fg, bg] = pair.split('|') as [string, string];
    lines.push(`| ${mode} | ${use} | \`${fg}\` | \`${bg}\` | ${ratio(fg, bg).toFixed(2)}:1 | ${min ? `${min}:1` : 'info'} |`);
  }
  return lines.join('\n');
}

// ---- main -----------------------------------------------------------------------------------------------------

if (process.argv.includes('--contrast')) {
  console.info(contrastTable());
  process.exit(0);
}
const outDir = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(here, '../../apps/web/public/brand'));
mkdirSync(outDir, { recursive: true });

const FAV: Tile = { cut: 'small', radius: RADIUS, scale: 0.92 }; // 32 px and below: the small cut, tight
const ICON: Tile = { cut: 'logo', radius: RADIUS, scale: 0.72 };
const BLEED: Tile = { cut: 'logo', radius: 0, scale: 0.72 }; // the platform masks it
const files: Record<string, string> = {
  'logo-light.svg': horizontal('logo', LIGHT),
  'logo-dark.svg': horizontal('logo', DARK),
  'logo-small-light.svg': horizontal('small', LIGHT),
  'logo-small-dark.svg': horizontal('small', DARK),
  'logo-stacked-light.svg': stacked(LIGHT),
  'logo-stacked-dark.svg': stacked(DARK),
  'symbol-light.svg': symbol('logo', LIGHT),
  'symbol-dark.svg': symbol('logo', DARK),
  'symbol-small-light.svg': symbol('small', LIGHT),
  'symbol-small-dark.svg': symbol('small', DARK),
  'wordmark-light.svg': wordmarkOnly(LIGHT),
  'wordmark-dark.svg': wordmarkOnly(DARK),
  'favicon.svg': tile(FAV),
};
for (const [name, svg] of Object.entries(files)) writeFileSync(join(outDir, name), svg);

const rasters: { name: string; px: number; tile: Tile }[] = [
  { name: 'favicon-16.png', px: 16, tile: FAV },
  { name: 'favicon-32.png', px: 32, tile: FAV },
  { name: 'favicon-48.png', px: 48, tile: ICON }, // only feeds the ICO: above 32 px the full cut
  { name: 'apple-touch-icon.png', px: 180, tile: { ...BLEED } }, // iOS rounds it
  { name: 'icon-192.png', px: 192, tile: ICON },
  { name: 'icon-512.png', px: 512, tile: ICON },
  { name: 'icon-maskable-512.png', px: 512, tile: BLEED },
  { name: 'avatar-500.png', px: 500, tile: { cut: 'logo', radius: 0, scale: 0.66 } },
];

const require = createRequire(join(here, '../../apps/web/package.json'));
const { chromium } = require('@playwright/test') as typeof import('@playwright/test');
const browser = await chromium.launch();
const png = new Map<string, Buffer>();
for (const r of rasters) {
  const page = await browser.newPage({ viewport: { width: r.px, height: r.px }, deviceScaleFactor: 1 });
  const svg = tile(r.tile).replace('width="64" height="64"', `width="${r.px}" height="${r.px}"`);
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
  png.set(r.name, await page.screenshot({ omitBackground: true, type: 'png' }));
  await page.close();
}
await browser.close();
for (const [name, data] of png) if (name !== 'favicon-48.png') writeFileSync(join(outDir, name), data);

// ICO with PNG-compressed frames (16, 32, 48), for every client that still asks for /favicon.ico.
const frames = [16, 32, 48].map((px) => {
  const data = png.get(`favicon-${px}.png`);
  if (!data) throw new Error(`missing favicon-${px}.png`);
  return { px, data };
});
const header = Buffer.alloc(6 + 16 * frames.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
frames.forEach((f, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(f.px, e); // width
  header.writeUInt8(f.px, e + 1); // height
  header.writeUInt8(0, e + 2); // palette size
  header.writeUInt8(0, e + 3); // reserved
  header.writeUInt16LE(1, e + 4); // colour planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(f.data.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += f.data.length;
});
writeFileSync(join(outDir, 'favicon.ico'), Buffer.concat([header, ...frames.map((f) => f.data)]));

// A maskable icon keeps its art inside the central 80 % circle: radius <= 0.4 of the side (25.6 of 64).
const safe = reach('logo', BLEED.scale);
if (safe > 25.6) throw new Error(`maskable icon art reaches ${safe.toFixed(1)} of 25.6`);
console.info(`wrote ${Object.keys(files).length} SVG, ${png.size - 1} PNG and the ICO to ${outDir}; maskable reach ${safe.toFixed(1)} / 25.6`);
