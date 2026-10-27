// The closing wordmark is set as wide as the frame. Its font size is worked out here, on the
// server, from Switzer Medium's advance widths, so it fits any product name with no script and
// no layout shift: the size is in cqi (percent of the frame's width).

// Advance widths of Switzer Medium capitals and digits, in em (measured in Chromium).
const ADVANCE: Record<string, number> = {
  A: 0.688,
  B: 0.635,
  C: 0.686,
  D: 0.701,
  E: 0.584,
  F: 0.576,
  G: 0.706,
  H: 0.7,
  I: 0.258,
  J: 0.54,
  K: 0.638,
  L: 0.544,
  M: 0.872,
  N: 0.7,
  O: 0.751,
  P: 0.61,
  Q: 0.751,
  R: 0.63,
  S: 0.611,
  T: 0.623,
  U: 0.685,
  V: 0.688,
  W: 1.052,
  X: 0.655,
  Y: 0.619,
  Z: 0.618,
  '-': 0.396,
  '.': 0.236,
  '&': 0.75,
  '!': 0.322,
  ' ': 0.196,
};
const DIGIT = 0.576;
const TRACKING = -0.045; // em, as .giant in landing.css
/** How much of the frame the word fills: about what Appduct's and Rozenite's wordmarks do. */
const FILL = 94;

/** The `font-size` for `.giant` that sets `word` (uppercased) across the frame. */
export function giantSize(word: string): string {
  const chars = [...word.toUpperCase()];
  const em = chars.reduce(
    (sum, c) => sum + (ADVANCE[c] ?? (/\d/.test(c) ? DIGIT : 0.65)) + TRACKING,
    0,
  );
  return `${(FILL / Math.max(em, 1)).toFixed(2)}cqi`;
}
