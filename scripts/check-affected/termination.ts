const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

// Aborts the controller on a termination signal and records the conventional shell exit code.
export function abortOnTerminationSignal(controller: AbortController): {
  cancellation: { code: number };
  dispose: () => void;
} {
  const cancellation = { code: 0 };
  const handlers = (Object.keys(SIGNAL_EXIT_CODES) as (keyof typeof SIGNAL_EXIT_CODES)[]).map(
    (signal) =>
      [
        signal,
        () => {
          cancellation.code = SIGNAL_EXIT_CODES[signal];
          controller.abort();
        },
      ] as const,
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  return {
    cancellation,
    dispose: () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}
