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

/** Sleeps on the runtime clock; without one, a timer that an abort of `signal` ends early. */
export async function sleep(
  runtime: Pick<AgentDeviceRuntime, 'clock'>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (runtime.clock) return await runtime.clock.sleep(ms);
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
