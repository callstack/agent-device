/**
 * Waits without naming what it is waiting for. This module imports nothing, so a caller that only
 * paces itself never evaluates the retry policy, its diagnostic telemetry, or the error vocabulary
 * `internal/retry.ts` carries.
 *
 * The leaf matters twice over. `settle-within.ts` states the same reason for the deadline primitive:
 * the eager-closure gate measures the difference. And the platform package policy reads the host-kit
 * module graph to decide which exports a managed platform package may import at runtime, because a
 * managed plugin is bundled with its own copy of host-kit: a module that reaches the exec layer or the
 * diagnostic store from that copy answers with the daemon's environment, outside the request's captured
 * environment and exec trace. Pacing stays on the clean side of that line.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    };
    const timer = setTimeout(finish, ms);

    function onAbort(): void {
      clearTimeout(timer);
      finish();
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
