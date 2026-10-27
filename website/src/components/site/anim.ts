// Timing helpers every hero animation uses.

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Adds a line to `parent` that takes its full size straight away but stays invisible until it
 * is typed or shown, so typing never reflows the layout around it.
 */
export function ghostLine(parent: HTMLElement, text: string, cls = '', prefix = '') {
  const el = document.createElement('div');
  el.className = `ln is-pending ${cls}`;
  el.innerHTML = prefix;
  const typed = document.createElement('span');
  const rest = document.createElement('span');
  rest.className = 'ghost';
  rest.textContent = text;
  el.append(typed, rest);
  parent.append(el);
  return {
    el,
    async type(speed = 28) {
      el.classList.remove('is-pending');
      for (let i = 1; i <= text.length; i++) {
        typed.textContent = text.slice(0, i);
        rest.textContent = text.slice(i);
        await sleep(speed);
      }
    },
    show() {
      el.classList.remove('is-pending');
      typed.textContent = text;
      rest.textContent = '';
    },
  };
}

/**
 * Runs an async animation loop only while `el` is on screen, and once (statically) when the
 * reader prefers reduced motion.
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

/**
 * Moves a packet along a duct in pixel steps (vertical when the duct is taller than wide),
 * lighting the duct while it travels.
 */
export function sendPacket(
  duct: HTMLElement,
  packet: HTMLElement,
  reverse = false,
  duration = 640,
) {
  const vertical = duct.clientHeight > duct.clientWidth;
  const prop = vertical ? 'top' : 'left';
  const frames = [{ [prop]: '0%' }, { [prop]: '100%' }];
  packet.style.opacity = '1';
  const anim = packet.animate(reverse ? frames.reverse() : frames, {
    duration,
    easing: 'steps(16)',
    fill: 'forwards',
  });
  duct.classList.add('is-live');
  return anim.finished.then(() => {
    packet.style.opacity = '0';
    duct.classList.remove('is-live');
  });
}
