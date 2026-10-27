// Starts a dithered canvas (see Dither.astro). Where the browser can, the canvas is handed to a
// worker so building and drawing the scene never blocks the page; otherwise it runs here.
import type { DitherOptions } from './dither';

let worker: Worker | undefined;
let next = 0;

export async function host(canvas: HTMLCanvasElement) {
  const options: DitherOptions = {
    scene: canvas.dataset.scene ?? 'mark',
    focus: Number(canvas.dataset.focus ?? 0.72),
    cell: Number(canvas.dataset.cell ?? 2),
    rgb: getComputedStyle(document.documentElement)
      .getPropertyValue('--accent-rgb')
      .trim()
      .split(/\s+/)
      .map(Number),
    still: matchMedia('(prefers-reduced-motion: reduce)').matches,
    // The mark's rows, joined with "/" by Dither.astro.
    mark: canvas.dataset.mark ? canvas.dataset.mark.split('/') : [],
  };

  let setSize: (width: number, height: number) => void;
  let setVisible: (on: boolean) => void;
  if ('transferControlToOffscreen' in canvas) {
    worker ??= new Worker(new URL('./dither.worker.ts', import.meta.url), { type: 'module' });
    const w = worker;
    const id = next++;
    const offscreen = canvas.transferControlToOffscreen();
    w.postMessage({ type: 'init', id, canvas: offscreen, ...options }, [offscreen]);
    setSize = (width, height) => w.postMessage({ type: 'size', id, width, height });
    setVisible = (on) => w.postMessage({ type: 'visible', id, on });
  } else {
    const run = (await import('./dither')).animate(canvas, options);
    setSize = run.setSize;
    setVisible = run.setVisible;
  }

  new ResizeObserver(() => setSize(canvas.clientWidth, canvas.clientHeight)).observe(canvas);
  new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting)).observe(canvas);
}
