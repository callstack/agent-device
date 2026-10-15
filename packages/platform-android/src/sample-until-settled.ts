import { sleep } from '@agent-device/host-kit/retry';

/**
 * Samples until `settled` accepts one or `timeoutMs` has passed, and returns the last sample. `read`
 * receives what is left of the budget so a stuck probe can be bounded by it. The last sleep ends at
 * the budget, so the final sample is taken there rather than an interval later.
 */
export async function sampleUntilSettled<T>(
  read: (remainingMs: number) => Promise<T>,
  settled: (sample: T) => boolean,
  options: Readonly<{ timeoutMs: number; intervalMs: number; signal?: AbortSignal }>,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    options.signal?.throwIfAborted();
    const sample = await read(Math.max(1, deadline - Date.now()));
    const remainingMs = deadline - Date.now();
    if (settled(sample) || remainingMs <= 0) return sample;
    await sleep(Math.min(options.intervalMs, remainingMs), options.signal);
  }
}
