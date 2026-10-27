/**
 * Calls `start` once, the first time `el` comes within `margin` of the viewport. Pair it with
 * a dynamic import() so the code behind it is fetched and run only then.
 */
export function whenNear(el: Element, start: () => void, margin = '200px') {
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      start();
    },
    { rootMargin: margin },
  );
  io.observe(el);
}
