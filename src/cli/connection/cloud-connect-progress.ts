import { writeStderrBestEffort } from '../process-exit.ts';

const PROGRESS_INTERVAL_MS = 5_000;

export function startCloudConnectProgress(
  windowMs: number,
  readDeadline: (signal: AbortSignal) => Promise<number | undefined>,
): () => void {
  const startedAt = performance.now();
  const controller = new AbortController();
  let timer = schedule();

  function schedule() {
    if (performance.now() - startedAt + PROGRESS_INTERVAL_MS >= windowMs) return undefined;
    const next = setTimeout(() => void tick(), PROGRESS_INTERVAL_MS);
    next.unref();
    return next;
  }

  async function tick() {
    const deadline = await readDeadline(controller.signal).catch(() => undefined);
    if (controller.signal.aborted) return;
    const elapsedSeconds = Math.floor((performance.now() - startedAt) / 1_000);
    const deadlineText =
      deadline === undefined ? '' : ` (session deadline ${new Date(deadline).toISOString()})`;
    writeStderrBestEffort(`connect cloud: allocating, ${elapsedSeconds}s elapsed${deadlineText}\n`);
    timer = schedule();
  }

  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}
