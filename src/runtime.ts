import { bindCommands, type BoundAgentDeviceCommands } from './commands/index.ts';
import { createAgentDeviceRuntime } from './runtime-factory.ts';
import type { AgentDeviceRuntime, AgentDeviceRuntimeConfig } from './runtime-contract.ts';

export type {
  AgentDeviceRuntime,
  AgentDeviceRuntimeConfig,
  CommandSessionStore,
} from './runtime-contract.ts';
export {
  createMemorySessionStore,
  localCommandPolicy,
  restrictedCommandPolicy,
} from './runtime-factory.ts';

export type AgentDevice = AgentDeviceRuntime & BoundAgentDeviceCommands;

export function createAgentDevice(config: AgentDeviceRuntimeConfig): AgentDevice {
  const runtime = createAgentDeviceRuntime(config);
  return {
    ...runtime,
    ...bindCommands(runtime),
  };
}
