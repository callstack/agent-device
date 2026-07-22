import type { AgentDeviceRuntime } from '../runtime-contract.ts';
import { bindRuntimeCommands } from './runtime-types.ts';
import {
  captureCommands,
  type BoundCaptureCommands,
  type CaptureCommands,
} from './capture/runtime/index.ts';
import {
  bindInteractionCommands,
  bindSelectorCommands,
  interactionCommands,
  selectorCommands,
  type BoundInteractionCommands,
  type BoundSelectorCommands,
  type InteractionCommands,
  type SelectorCommands,
} from './interaction/runtime/index.ts';
import {
  adminCommands,
  appCommands,
  bindAppCommands,
  type AdminCommands,
  type AppCommands,
  type BoundAdminCommands,
  type BoundAppCommands,
} from './management/runtime/index.ts';
import {
  diagnosticsCommands,
  type BoundObservabilityCommands,
  type DiagnosticsCommands,
} from './observability/runtime/index.ts';
import {
  recordingCommands,
  type BoundRecordingCommands,
  type RecordingCommands,
} from './recording/runtime/index.ts';
import {
  systemCommands,
  type BoundSystemCommands,
  type SystemCommands,
} from './system/runtime/index.ts';

export type { ScreenshotCommandOptions } from './runtime-types.ts';

export type AgentDeviceCommands = {
  capture: CaptureCommands;
  selectors: SelectorCommands;
  interactions: InteractionCommands;
  system: SystemCommands;
  apps: AppCommands;
  admin: AdminCommands;
  recording: RecordingCommands;
  diagnostics: DiagnosticsCommands;
};

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

/**
 * @internal Runtime command catalog used by parity/type tests.
 */
export const commands: AgentDeviceCommands = {
  capture: captureCommands,
  selectors: selectorCommands,
  interactions: interactionCommands,
  system: systemCommands,
  apps: appCommands,
  admin: adminCommands,
  recording: recordingCommands,
  diagnostics: diagnosticsCommands,
};

export function bindCommands(runtime: AgentDeviceRuntime): BoundAgentDeviceCommands {
  return {
    capture: bindRuntimeCommands(captureCommands, runtime),
    selectors: bindSelectorCommands(runtime),
    interactions: bindInteractionCommands(runtime),
    system: bindRuntimeCommands(systemCommands, runtime),
    apps: bindAppCommands(runtime),
    admin: bindRuntimeCommands(adminCommands, runtime),
    recording: bindRuntimeCommands(recordingCommands, runtime),
    observability: bindRuntimeCommands(diagnosticsCommands, runtime),
  };
}
