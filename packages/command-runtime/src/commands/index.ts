import type { AgentDeviceRuntime } from '@agent-device/contracts/runtime-contract';
import { bindRuntimeCommands } from './runtime-types.ts';
import { bindCaptureCommands, type BoundCaptureCommands } from './capture/runtime/index.ts';
import {
  bindInteractionCommands,
  bindSelectorCommands,
  type BoundInteractionCommands,
  type BoundSelectorCommands,
} from './interaction/runtime/index.ts';
import { recordingCommands, type BoundRecordingCommands } from './recording/runtime/index.ts';

export type { ScreenshotCommandOptions } from './runtime-types.ts';

export type BoundAgentDeviceCommands = {
  capture: BoundCaptureCommands;
  selectors: BoundSelectorCommands;
  interactions: BoundInteractionCommands;
  recording: BoundRecordingCommands;
};

export function bindCommands(runtime: AgentDeviceRuntime): BoundAgentDeviceCommands {
  return {
    capture: bindCaptureCommands(runtime),
    selectors: bindSelectorCommands(runtime),
    interactions: bindInteractionCommands(runtime),
    recording: bindRuntimeCommands(recordingCommands, runtime),
  };
}
