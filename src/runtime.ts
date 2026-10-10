import { bindCommands, type BoundAgentDeviceCommands } from './commands/index.ts';
import { createAgentDeviceRuntime } from './command-runtime/runtime-factory.ts';
import type {
  AgentDeviceRuntime,
  AgentDeviceRuntimeConfig,
} from '@agent-device/contracts/runtime-contract';

export type AgentDevice = AgentDeviceRuntime & BoundAgentDeviceCommands;

export function createAgentDevice(config: AgentDeviceRuntimeConfig): AgentDevice {
  const runtime = createAgentDeviceRuntime(config);
  return {
    ...runtime,
    ...bindCommands(runtime),
  };
}
