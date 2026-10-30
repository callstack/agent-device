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
import { createAgentDeviceRuntime } from './command-runtime/runtime-factory.ts';
import type {
  AgentDeviceRuntime,
  AgentDeviceRuntimeConfig,
} from '@agent-device/contracts/runtime-contract';

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

export type {
  RecordingContactSheetCommandOptions,
  RecordingContactSheetCommandResult,
} from './commands/recording/runtime/contact-sheet.ts';
export async function executeRecordingContactSheet(
  config: AgentDeviceRuntimeConfig,
  options: import('./commands/recording/runtime/contact-sheet.ts').RecordingContactSheetCommandOptions,
): Promise<
  import('./commands/recording/runtime/contact-sheet.ts').RecordingContactSheetCommandResult
> {
  const { createAgentDevice } = await import('./runtime.ts');
  return createAgentDevice(config).recording.contactSheet(options);
}
