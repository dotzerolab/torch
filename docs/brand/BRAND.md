# Torch brand guidelines

The default brand of Torch, an open-source issue tracker made by the DotZeroLab organisation. An instance can wear its
own name, logo and colours instead (white label: `config/brand.default.json`, [fork-sync.md](../fork-sync.md)); this
guide describes the brand Torch ships with. Every file is drawn in code: `node docs/brand/build.ts` rebuilds all of them.

## 1. Idea

A blue flame, split in two, with a pale caret across the split.

- **The flame** is the name: one light that a team carries together.
- **The split** is a handoff: work passes from one pair of hands to the next. The two blues are the two sides.
- **The caret ^** crosses the slit and joins the halves. It is the family signature of the DotZeroLab projects: a white
  chevron with round caps and joins, legs at 45°.

Tone: precise, calm, no hype. The mark is simple enough to be drawn from a handful of circles.

## 2. Files

All in `apps/web/public/brand/`. SVGs carry no product name and no accessible name (`aria-hidden`); the page or the
`alt` text supplies it, so a white-label instance never inherits one.

| File | Use |
|---|---|
| `logo-light.svg`, `logo-dark.svg` | Horizontal logo: symbol + wordmark. Default. `-dark` is for dark surfaces. Full cut, for logos taller than 36 px |
| `logo-small-light.svg`, `logo-small-dark.svg` | Horizontal logo with the small cut of the symbol, for 20 to 36 px high |
| `logo-stacked-light.svg`, `logo-stacked-dark.svg` | Stacked logo for square or narrow spaces |
| `symbol-light.svg`, `symbol-dark.svg` | The symbol alone, full cut |
| `symbol-small-light.svg`, `symbol-small-dark.svg` | The symbol alone, small cut |
| `wordmark-light.svg`, `wordmark-dark.svg` | The name alone, when the symbol already appears next to it |
| `favicon.svg` | Small cut on a dark rounded tile; the browser tab icon |
| `favicon.ico` (16, 32, 48), `favicon-16.png`, `favicon-32.png` | Fallbacks for clients without SVG icons. 16 and 32 use the small cut, the 48 frame the full cut |
| `apple-touch-icon.png` (180) | Full cut on a full-bleed square tile; iOS rounds it |
| `icon-192.png`, `icon-512.png` | Android icons: full cut on the rounded tile |
| `icon-maskable-512.png` | Android maskable: full-bleed tile, art inside the central 80 % circle (it reaches 85 % of that radius) |
| `avatar-500.png` | Square avatar for code hosts and chat: full cut on the full-bleed tile |

`index.html` links the SVG favicon first, then the 32 and 16 px PNGs and the touch icon. `config/brand.default.json`
points at `logo-light.svg`, `logo-dark.svg` and `favicon.svg` and sets `accentColor` to `#2A5FF2`.

## 3. Two cuts of the symbol

Both are built on the same grid (section 6) and read as one family.

| Cut | Used for | What differs |
|---|---|---|
| **Full** (`symbol`, `logo`) | Any render taller than 32 px: README, sign-in, documents, large icons | Two tongues (main flame and a small lick), slit at 8.3°, lighter caret |
| **Small** (`symbol-small`, `logo-small`, favicon) | Any render of 32 px or less: tabs, lists, small headers | One tongue, slit at 13.3° with a wider channel, heavier caret. At 16 px the lick and a 0.7 px slit would vanish, the small cut keeps the drop, both blues and the caret |

Checked at 96, 32 and 16 px, light and dark.

## 4. Colour

One accent, `#2A5FF2`; neutrals for everything else. The right half of the flame **is** the accent: `#2A5FF2` on light,
its tint `#5C8CFD` on dark. The left half is the same hue one step deeper. The palette was built in OKLCH (lightness,
chroma, hue), not picked by eye, and checked against WCAG 2.2, APCA and colour-vision simulations.

| Token | Light | Dark | OKLCH (light / dark) | Role |
|---|---|---|---|---|
| Accent | `#2A5FF2` | `#5C8CFD` | 0.546 · 0.228 · 264.6° / 0.661 · 0.176 · 264.7° | Brand accent in `config/brand.default.json` (focus, selection, links, large UI); also the right half |
| Mark, left half | `#0D048F` | `#2A4AE5` | 0.301 · 0.199 · 267.1° / 0.498 · 0.235 · 267.1° | The flame, left of the slit: the accent one step deeper, 2.5° towards indigo |
| Mark, right half | `#2A5FF2` | `#5C8CFD` | as the accent | The flame, right of the slit (lifted) |
| Caret | `#F4FBFF` | `#F4FBFF` | 0.984 · 0.009 · 232.4° | The caret ^ |
| Surface | `#F6FAFF` | `#080A11` | | Page background |
| Ink | `#080A11` | `#F6FAFF` | | Wordmark and text |
| Icon tile | `#03081F` | `#03081F` | 0.146 · 0.051 · 266.7° | Background of every icon file (icons use the dark palette) |

`config/brand.default.json` keeps `accentColor` at `#2A5FF2`, the light value. The configuration has one accent today;
a dark theme takes `#5C8CFD` as its accent (6.24:1 as text on the dark surface).

Contrast (WCAG 2.2: text 4.5:1, graphics 3:1; APCA Lc is the absolute lightness contrast; the 2:1 gap between the two
halves is a target of the brand, not a WCAG rule; computed by `node docs/brand/build.ts --contrast`):

| Mode | Pair | Foreground | Background | WCAG | Needs | APCA Lc |
|---|---|---|---|---|---|---|
| Light | Wordmark and text | `#080A11` | `#F6FAFF` | 18.87:1 | 4.5:1 | 103 |
| Light | Left half on the surface | `#0D048F` | `#F6FAFF` | 14.00:1 | 3:1 | 96 |
| Light | Right half = brand accent, on the surface (also as text) | `#2A5FF2` | `#F6FAFF` | 4.99:1 | 4.5:1 | 72 |
| Light | White text on the brand accent | `#FFFFFF` | `#2A5FF2` | 5.23:1 | 4.5:1 | 81 |
| Light | Caret on the left half | `#F4FBFF` | `#0D048F` | 14.04:1 | 3:1 | 99 |
| Light | Caret on the right half | `#F4FBFF` | `#2A5FF2` | 5.00:1 | 3:1 | 77 |
| Light | Right half against the left half (the slit separates them) | `#2A5FF2` | `#0D048F` | 2.81:1 | 2:1 | 21 |
| Dark | Wordmark and text | `#F6FAFF` | `#080A11` | 18.87:1 | 4.5:1 | 104 |
| Dark | Left half on the surface | `#2A4AE5` | `#080A11` | 3.02:1 | 3:1 | 20 |
| Dark | Right half = accent tint, on the surface (also as text) | `#5C8CFD` | `#080A11` | 6.24:1 | 4.5:1 | 43 |
| Dark | Dark text on the accent tint | `#080A11` | `#5C8CFD` | 6.24:1 | 4.5:1 | 45 |
| Dark | Caret on the left half | `#F4FBFF` | `#2A4AE5` | 6.26:1 | 3:1 | 83 |
| Dark | Caret on the right half | `#F4FBFF` | `#5C8CFD` | 3.03:1 | 3:1 | 61 |
| Dark | Right half against the left half (the slit separates them) | `#5C8CFD` | `#2A4AE5` | 2.06:1 | 2:1 | 22 |
| Tile | Left half on the icon tile | `#2A4AE5` | `#03081F` | 3.03:1 | 3:1 | 20 |
| Tile | Right half on the icon tile | `#5C8CFD` | `#03081F` | 6.26:1 | 3:1 | 43 |
| Tile | Caret on the icon tile | `#F4FBFF` | `#03081F` | 18.98:1 | 3:1 | 104 |

Notes
- **Gap between the two blues.** 2.81:1 on light (ΔE<sub>OK</sub> 24.7) and 2.06:1 on dark (ΔE<sub>OK</sub> 17.4). **2:1 is the ceiling in the dark theme:** the left half must stay at least 3:1 on the
  near-black surface (it is 3.02:1) and the caret at least 3:1 on the right half (3.03:1), which caps the right half's
  brightness. There is no slack on either side; even a pure-white caret would lift the ceiling only to 2.17:1. Do not
  lighten the right half, darken the left half or tint the caret darker without re-checking both.
- **APCA.** On the dark surface the left half scores Lc 20 and the right half Lc 43; APCA is strict on dark blue over
  near-black. Lc 45 for the left half needs an OKLCH lightness of 0.675, brighter than the right half's ceiling, so the
  two halves would merge into one blue. The WCAG 1.4.11 target (3:1) is the one the brand keeps; the two halves are
  large shapes and the wordmark carries the name.
- **Colour-vision deficiency** (simulated with the Machado 2009 matrices at full severity, plus greyscale). The halves
  stay two halves in every simulation; ratio between them and ΔE<sub>OK</sub>:

| Simulation | Light ratio | Light ΔE | Dark ratio | Dark ΔE |
|---|---|---|---|---|
| Normal vision | 2.81:1 | 24.7 | 2.06:1 | 17.4 |
| Protanopia | 2.71:1 | 23.7 | 1.79:1 | 14.7 |
| Deuteranopia | 2.52:1 | 22.4 | 1.84:1 | 14.5 |
| Tritanopia | 2.84:1 | 24.8 | 1.80:1 | 14.5 |
| Greyscale | 2.81:1 | 25.4 | 2.09:1 | 17.8 |

- **Icon tile.** It is a night blue no brighter than the dark surface. A brighter tile such as `#090D22` would put the
  dark left half at 2.94:1 on it, under 3:1.

Rules: use the accent for shapes, focus rings and large UI; on the dark surface use `#5C8CFD`, never `#2A5FF2` for small
text (3.78:1). The slit between the two halves must stay open. No gradients, shadows or other effects.

## 5. Wordmark

**Torch**, one word, set in **Orbitron SemiBold** and converted to outlines (integer font units, no font is loaded).

- Why Orbitron: it is the typeface of the DotZeroLab wordmark, and products of one organisation follow one line.
  It is wide, squared and round at once, monoline, and its round `o` and `c` echo the round belly of the flame.
- Weight: SemiBold, as the organisation's wordmark. Its stem is 0.165 of the cap height.
- Use it for the name only, not for body text or headings. The interface uses its own text typeface.
- Licence: SIL Open Font License 1.1, copy in [licenses/OFL-Orbitron.txt](licenses/OFL-Orbitron.txt). The licence allows
  using the font to make artwork such as this logo.

## 6. Construction: the golden ratio

One scale. **A = flame height = 100 units.** Every length is A divided by a power of phi (phi = 1.618; √phi = 1.272).
The flame is made of circular arcs only, so the construction circles are the shape. The generator `build.ts` derives
every coordinate from this scale, then fits the mark into a 64 × 64 box with a 2 unit margin.

Full cut:

| Measure | Ratio | Value (A = 100) |
|---|---|---|
| Flame height : belly width | phi | 100 : 61.8 |
| Belly circle, radius | A / (2 phi) | 30.9 |
| Tongue zone (tip to belly top) : flame height | phi⁻² | 38.2 : 100 |
| Flank, convex arc | radius = belly width, centred on the opposite widest point | 61.8 |
| Flank, concave arc to the tip | A / phi² | 38.2 |
| Tip offset from the axis | R / phi⁴ | 4.5 |
| Notch, on the belly-top line, left of the axis | y = A / phi², x = R / phi³ | y 38.2, x −7.3 |
| Lick tip, on the flank circle | y = A / phi³ + A / phi⁷ | y 27.0, x −15.5 |
| Lick scoop radius, tongue edge radius | A / phi⁴, A / phi | 14.6, 61.8 |
| Slit slope (dx : dy), through the belly centre | phi⁻⁴ | 0.146 (8.3° from vertical) |
| Right half lifted by (+s, −s) | s = A / phi⁶ | 5.6; channel 4.7 |
| Caret path width | A / phi^2.5 (phi² · √phi) | 29.9 |
| Caret stroke, one weight, round caps and joins | A / phi⁴ | 14.6 |
| Round shapes overshoot the grid by | about A / phi⁹ | 1.2 |

Small cut: the same belly and flank arcs, with the second tongue removed (the left flank mirrors the right one) and
three values changed: slit slope phi⁻³ (13.3°), lift s = A / phi⁵ (channel 6.7), caret path width A / phi³ (23.6),
which makes the caret width : stroke exactly phi.

The caret has 45° legs, its apex sits on the slit centre line and its visible centre on the belly centre (0.1 R higher
in the full cut, so its feet stay clear of the outline).

Lockups:

| Lockup | Wordmark cap height | Gap between symbol and wordmark |
|---|---|---|
| Horizontal | = belly width (A / phi): the T top sits on the belly-top line and the baseline on the flame bottom | A / phi³ |
| Stacked | A / phi² (belly width / phi), centred under the symbol | A / phi³ |

Icon tiles: corner radius = tile size / phi³. The full-bleed tiles (touch icon, maskable) have no radius.

## 7. Clear space and minimum size

- Clear space: A / phi² (38 % of the flame height) on every side of the logo and the symbol. Keep text and other
  graphics out of it.
- Minimum size: symbol 16 px high (small cut up to 32 px); horizontal logo 36 px high, `logo-small` from 20 px;
  stacked logo 58 px high; wordmark alone 64 px wide.

## 8. Do and don't

Do
- Use the files as they are, in the light or dark version that matches the surface.
- Use the small cut for every render of 32 px or less, and the full cut above.
- Keep the slit open and the caret at 45°.

Don't
- Stretch, rotate, flip, outline, add shadows or gradients, or crop the tip.
- Swap the two blues, recolour outside the palette, or put the logo on a busy image.
- Redraw the caret or set the name in another typeface.
- Enlarge the small cut for large uses, or shrink the full cut below 32 px.
- Write the product name into an SVG that a white-label instance can serve (`pnpm brand:check` forbids it).

## 9. Licence of the marks

The generator, the SVG and PNG files and this guide are part of the repository and Apache-2.0 like the rest of it. The
Torch name, the symbol and the wordmark are marks of the DotZeroLab organisation: section 6 of the Apache License
grants no right to use them. Using the unmodified files to refer to the project (README, articles, "works with
Torch") is fine. An instance or a fork that ships under another name replaces them through its own brand file
(`BRAND_CONFIG_PATH`) and its own logos. The typeface keeps its own licence (section 5).

## 10. Rebuild and checks

```sh
pnpm install
pnpm --filter @torch/web exec playwright install chromium   # first time, for the PNGs
node docs/brand/build.ts                                     # writes apps/web/public/brand
node docs/brand/build.ts --contrast                          # prints the contrast table above
pnpm brand:check                                             # the product name only where allowed
```

The generator fails if the maskable icon's art leaves the central 80 % circle.
