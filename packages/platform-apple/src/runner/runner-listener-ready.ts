const RUNNER_LISTENER_READY_MARKER = 'AGENT_DEVICE_RUNNER_LISTENER_READY';

export type RunnerListenerReadySignal = Readonly<{
  wake: AbortSignal;
  observe(chunk: string): void;
  finish(): void;
}>;

/**
 * Turns the runner's authoritative NWListener-ready log marker into a one-shot host signal.
 * The marker arrives as whatever the host can read of the runner's output — a tailed log file since
 * #2681 — and a line can straddle two reads, so the scanner retains only the shortest suffix that
 * can complete the marker on the next one.
 */
export function createRunnerListenerReadySignal(): RunnerListenerReadySignal {
  const wake = new AbortController();
  let settled = false;
  let tail = '';
  return {
    wake: wake.signal,
    observe: (chunk) => {
      if (settled) return;
      const candidate = tail + chunk;
      if (candidate.includes(RUNNER_LISTENER_READY_MARKER)) {
        settled = true;
        tail = '';
        wake.abort();
        return;
      }
      tail = candidate.slice(-(RUNNER_LISTENER_READY_MARKER.length - 1));
    },
    finish: () => {
      settled = true;
      tail = '';
      wake.abort();
    },
  };
}
