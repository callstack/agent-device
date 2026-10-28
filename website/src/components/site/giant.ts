// The closing wordmark is set as wide as the frame. Its font size is worked out here, on the
// server, so it fits any product name with no script and no layout shift: the size is in cqi
// (percent of the frame's width). The wordmark is set like the lockup, in Geist Mono Medium,
// where every character advances 0.6em (measured in Chromium).

const ADVANCE = 0.6;
const TRACKING = -0.02; // em, as .giant in landing.css
/** How much of the frame the word fills. */
const FILL = 94;

/** The `font-size` for `.giant` that sets `word` across the frame. */
export function giantSize(word: string): string {
  const em = [...word].length * (ADVANCE + TRACKING);
  return `${(FILL / Math.max(em, 0.01)).toFixed(2)}cqi`;
}
