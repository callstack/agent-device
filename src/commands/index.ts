import type { AgentDeviceRuntime } from '../runtime-contract.ts';
import { bindRuntimeCommands } from './runtime-types.ts';
import { bindCaptureCommands, type BoundCaptureCommands } from './capture/runtime/index.ts';
import {
  bindInteractionCommands,
  bindSelectorCommands,
  type BoundInteractionCommands,
  type BoundSelectorCommands,
} from './interaction/runtime/index.ts';
import {
  adminCommands,
  bindAppCommands,
  type BoundAdminCommands,
  type BoundAppCommands,
} from './management/runtime/index.ts';
import {
  diagnosticsCommands,
  type BoundObservabilityCommands,
} from './observability/runtime/index.ts';
import { recordingCommands, type BoundRecordingCommands } from './recording/runtime/index.ts';
import { systemCommands, type BoundSystemCommands } from './system/runtime/index.ts';

export type { ScreenshotCommandOptions } from './runtime-types.ts';

export type BoundAgentDeviceCommands = {
  capture: BoundCaptureCommands;
  selectors: BoundSelectorCommands;
  interactions: BoundInteractionCommands;
  system: BoundSystemCommands;
  apps: BoundAppCommands;
  admin: BoundAdminCommands;
  recording: BoundRecordingCommands;
  observability: BoundObservabilityCommands;
};

export function bindCommands(runtime: AgentDeviceRuntime): BoundAgentDeviceCommands {
  return {
    capture: bindCaptureCommands(runtime),
    selectors: bindSelectorCommands(runtime),
    interactions: bindInteractionCommands(runtime),
    system: bindRuntimeCommands(systemCommands, runtime),
    apps: bindAppCommands(runtime),
    admin: bindRuntimeCommands(adminCommands, runtime),
    recording: bindRuntimeCommands(recordingCommands, runtime),
    observability: bindRuntimeCommands(diagnosticsCommands, runtime),
  };
}
