// Timing helpers every hero animation uses.

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs an async animation loop while `el` is on screen, and once (statically) when the reader
 * prefers reduced motion. A cycle that is running when `el` leaves the screen finishes first.
 */
export function whenVisible(el: Element, loop: () => Promise<void>, still: () => void) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    still();
    return;
  }
  let visible = false;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    while (visible) await loop();
    running = false;
  };
  new IntersectionObserver(([entry]) => {
    visible = !!entry?.isIntersecting;
    if (visible) void run();
  }).observe(el);
}
