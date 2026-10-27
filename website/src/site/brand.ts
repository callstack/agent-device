// The product's accent, in one place. Change these four values and the whole site follows: the
// landing pages and the docs (CSS variables injected by Site.astro and the Starlight `head`
// entry in astro.config.mjs), code colours (ec.config.mjs, CodeBlock.astro via --code-*), the
// dithered scenes (they read --accent-rgb), the social card, the banner and the icons
// (scripts/og.mjs). No other file may hard-code an accent hex.
//
// agent-device's violet, derived with the skill's palette script. Accents in the Callstack
// product family:
//   Apex          lime          #c6f432
//   Simlock       orange        #ff7a1a
//   Appduct       cyan          #3ddcff
//   agent-device  violet        #a47bff (family colour #8232ff)
//   Rozenite      crimson-rose  #ff4f7b
//
// Pick an accent that is bright on near-black (at least 4.5:1 on #0a0a0a) and carries dark
// text on top of it. Then pick the two light-mode colours for the docs, where the bright accent
// is too pale on white.

/** Brand, primary actions, the second beat of headlines, strings in code. */
export const accent = '#a47bff';
/** Hover on accent fills: the accent mixed about halfway to white. */
export const accentHover = '#cab2ff';
/** Light-mode docs: accent text and links. Must be at least 4.5:1 on white (this is 5.6:1). */
export const accentDeep = '#7740f0';
/** Light-mode docs: rules, borders, the current sidebar item. */
export const accentRule = '#8e62f2';

// ---------- Derived values: nothing below needs editing ----------

const BG = '#0a0a0a';
const WHITE = '#ffffff';

/** `#rrggbb` as [r, g, b]. */
export function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `a` mixed toward `b` by `t` (0..1), as `#rrggbb`. */
export function mix(a: string, b: string, t: number): string {
  const x = rgbOf(a);
  const y = rgbOf(b);
  return `#${x
    .map((c, i) =>
      Math.round(c + (y[i]! - c) * t)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The accent as `r g b`, for `rgb(var(--accent-rgb) / 0.5)` and the dither palette. */
export const accentRgb = rgbOf(accent).join(' ');

/**
 * The accent as CSS variables on :root. Injected into every page's <head>: by Site.astro on the
 * landing pages and by the Starlight `head` config on the docs, so both read the same values.
 */
export const brandCss = `:root{${Object.entries({
  '--accent': accent,
  '--accent-hover': accentHover,
  '--accent-rgb': accentRgb,
  '--accent-deep': accentDeep,
  '--accent-rule': accentRule,
  // Starlight's accent backgrounds: a dark tint for dark mode, a pale one for light mode.
  '--accent-low': mix(BG, accent, 0.2),
  '--accent-low-light': mix(WHITE, accent, 0.14),
  '--accent-high-light': mix(accentDeep, '#000000', 0.25),
})
  .map(([k, v]) => `${k}:${v}`)
  .join(';')}}`;
