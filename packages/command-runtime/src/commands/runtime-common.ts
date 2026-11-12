import type { BackendCommandContext } from '@agent-device/contracts/backend';
import type { AgentDeviceRuntime, CommandContext } from '@agent-device/contracts/runtime-contract';

export function toBackendContext(
  runtime: Pick<AgentDeviceRuntime, 'signal'>,
  options: CommandContext,
): BackendCommandContext {
  return {
    session: options.session,
    requestId: options.requestId,
    signal: options.signal ?? runtime.signal,
    metadata: options.metadata,
  };
}

export function now(runtime: Pick<AgentDeviceRuntime, 'clock'>): number {
  return runtime.clock?.now() ?? Date.now();
}

/** Sleeps on the runtime clock, or a timer without one; an abort of `signal` ends either early. */
export async function sleep(
  runtime: Pick<AgentDeviceRuntime, 'clock'>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const slept = runtime.clock
    ? runtime.clock.sleep(ms)
    : new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
  try {
    await Promise.race([slept, aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
