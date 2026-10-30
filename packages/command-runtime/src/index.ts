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

import type {
  RecordingContactSheetCommandOptions,
  RecordingContactSheetCommandResult,
} from './commands/recording/runtime/contact-sheet.ts';

/**
 * The in-process executor shares the one construction path with `createAgentDevice`, which binds
 * every family for the public surface. This shape binds only capture, selectors and interaction;
 * the other families stay lazy.
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

export type {
  RecordingContactSheetCommandOptions,
  RecordingContactSheetCommandResult,
} from './commands/recording/runtime/contact-sheet.ts';
/** Loads the full runtime on demand for the CLI's contact-sheet action. */
export async function executeRecordingContactSheet(
  config: AgentDeviceRuntimeConfig,
  options: RecordingContactSheetCommandOptions,
): Promise<RecordingContactSheetCommandResult> {
  const { createAgentDevice } = await import('./runtime.ts');
  return createAgentDevice(config).recording.contactSheet(options);
}
