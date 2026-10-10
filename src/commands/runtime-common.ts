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

export async function sleep(runtime: Pick<AgentDeviceRuntime, 'clock'>, ms: number): Promise<void> {
  if (runtime.clock) await runtime.clock.sleep(ms);
  else await new Promise((resolve) => setTimeout(resolve, ms));
}
