import {
  bindInteractionCommands,
  bindSelectorCommands,
  type BoundInteractionCommands,
  type BoundSelectorCommands,
} from './commands/interaction/runtime/index.ts';
import {
  bindCaptureCommands,
  type BoundCaptureCommands,
} from './commands/capture/runtime/index.ts';
import { createAgentDeviceRuntime } from './runtime-factory.ts';
import type { AgentDeviceRuntime, AgentDeviceRuntimeConfig } from './runtime-contract.ts';

/**
 * The command surface an in-process executor dispatches through: capture, selector reads and
 * interactions. `src/runtime.ts` binds every family for the public SDK and CLI surface; a host
 * that only executes these three should not evaluate the management, recording, observability and
 * system families to get them. The runtime assembly is shared with `createAgentDevice`, so there
 * is one construction path and this differs only in the families it binds.
 */
export type CommandSurfaceAgentDevice = AgentDeviceRuntime & {
  capture: BoundCaptureCommands;
  selectors: BoundSelectorCommands;
  interactions: BoundInteractionCommands;
};

export function createCommandSurfaceAgentDevice(
  config: AgentDeviceRuntimeConfig,
): CommandSurfaceAgentDevice {
  const runtime = createAgentDeviceRuntime(config);
  return {
    ...runtime,
    capture: bindCaptureCommands(runtime),
    selectors: bindSelectorCommands(runtime),
    interactions: bindInteractionCommands(runtime),
  };
}
