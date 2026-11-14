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

One accent, `#2A5FF2`; neutrals for everything else. The mark uses a deeper blue for the left half and a brighter one
for the right half, lifted in the dark palette.

| Token | Light | Dark | Role |
|---|---|---|---|
| Accent | `#2A5FF2` | `#2A5FF2` | Brand accent in `config/brand.default.json` (focus, selection, large UI) |
| Mark, left half | `#1A2FB5` | `#3552E8` | The flame, left of the slit |
| Mark, right half | `#2F6BFF` | `#4F82FF` | The flame, right of the slit (lifted) |
| Caret | `#DDF6FF` | `#E8F8FF` | The caret ^ |
| Surface | `#F6FAFF` | `#080A11` | Page background |
| Ink | `#080A11` | `#F6FAFF` | Wordmark and text |
| Icon tile | `#090D22` | `#090D22` | Background of every icon file |

Contrast (WCAG 2.2; text 4.5:1, graphics 3:1; computed by `node docs/brand/build.ts --contrast`):

| Mode | Pair | Foreground | Background | Ratio | Needs |
|---|---|---|---|---|---|
| Light | Wordmark and text | `#080A11` | `#F6FAFF` | 18.87:1 | 4.5:1 |
| Light | Left half on the surface | `#1A2FB5` | `#F6FAFF` | 9.46:1 | 3:1 |
| Light | Right half on the surface | `#2F6BFF` | `#F6FAFF` | 4.29:1 | 3:1 |
| Light | Brand accent on the surface | `#2A5FF2` | `#F6FAFF` | 4.99:1 | 3:1 |
| Light | White text on the brand accent | `#FFFFFF` | `#2A5FF2` | 5.23:1 | 4.5:1 |
| Light | Caret on the left half | `#DDF6FF` | `#1A2FB5` | 8.83:1 | 3:1 |
| Light | Caret on the right half | `#DDF6FF` | `#2F6BFF` | 4.01:1 | 3:1 |
| Light | Right half against the left half (the slit separates them) | `#2F6BFF` | `#1A2FB5` | 2.20:1 | info |
| Dark | Wordmark and text | `#F6FAFF` | `#080A11` | 18.87:1 | 4.5:1 |
| Dark | Left half on the surface | `#3552E8` | `#080A11` | 3.32:1 | 3:1 |
| Dark | Right half on the surface | `#4F82FF` | `#080A11` | 5.62:1 | 3:1 |
| Dark | Brand accent on the surface | `#2A5FF2` | `#080A11` | 3.78:1 | 3:1 |
| Dark | Caret on the left half | `#E8F8FF` | `#3552E8` | 5.48:1 | 3:1 |
| Dark | Caret on the right half | `#E8F8FF` | `#4F82FF` | 3.23:1 | 3:1 |
| Dark | Right half against the left half (the slit separates them) | `#4F82FF` | `#3552E8` | 1.69:1 | info |
| Tile | Left half on the icon tile | `#3552E8` | `#090D22` | 3.23:1 | 3:1 |
| Tile | Right half on the icon tile | `#4F82FF` | `#090D22` | 5.47:1 | 3:1 |
| Tile | Caret on the icon tile | `#E8F8FF` | `#090D22` | 17.67:1 | 3:1 |

Rules: the accent is for shapes and large UI on dark surfaces (3.78:1), never for small text there; use a lighter tint
of the same hue for text. The two halves are only 1.69:1 (dark) and 2.20:1 (light) apart, so the slit between them must
stay open. No gradients, shadows or other effects.

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
