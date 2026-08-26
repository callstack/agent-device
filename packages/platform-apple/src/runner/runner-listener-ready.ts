const RUNNER_LISTENER_READY_MARKER = 'AGENT_DEVICE_RUNNER_LISTENER_READY';

export type RunnerListenerReadySignal = Readonly<{
  wake: AbortSignal;
  observe(source: 'stdout' | 'stderr', chunk: string): void;
  finish(): void;
}>;

/**
 * Turns the runner's authoritative NWListener-ready log marker into a one-shot host signal.
 * xcodebuild may split one log line across process-output chunks, so the scanner retains only the
 * shortest suffix that can complete the marker on the next chunk.
 */
export function createRunnerListenerReadySignal(): RunnerListenerReadySignal {
  const wake = new AbortController();
  let settled = false;
  const tails = { stdout: '', stderr: '' };
  return {
    wake: wake.signal,
    observe: (source, chunk) => {
      if (settled) return;
      const candidate = tails[source] + chunk;
      if (candidate.includes(RUNNER_LISTENER_READY_MARKER)) {
        settled = true;
        tails.stdout = '';
        tails.stderr = '';
        wake.abort();
        return;
      }
      tails[source] = candidate.slice(-(RUNNER_LISTENER_READY_MARKER.length - 1));
    },
    finish: () => {
      settled = true;
      tails.stdout = '';
      tails.stderr = '';
      wake.abort();
    },
  };
}
