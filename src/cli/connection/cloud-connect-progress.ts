import { writeStderrBestEffort } from '../process-exit.ts';

const PROGRESS_INTERVAL_MS = 5_000;

export type CloudAllocationProgress =
  | { kind: 'allocating'; deadlineAt?: string }
  | { kind: 'settled' };

export function startCloudConnectProgress(
  windowMs: number,
  readProgress: (signal: AbortSignal) => Promise<CloudAllocationProgress | undefined>,
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
    const progress = await readProgress(controller.signal).catch(() => undefined);
    if (controller.signal.aborted) return;
    if (progress?.kind === 'settled') {
      controller.abort();
      return;
    }
    const elapsedSeconds = Math.floor((performance.now() - startedAt) / 1_000);
    const deadlineText = progress?.deadlineAt ? ` (session deadline ${progress.deadlineAt})` : '';
    writeStderrBestEffort(`connect cloud: allocating, ${elapsedSeconds}s elapsed${deadlineText}\n`);
    timer = schedule();
  }

  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}
