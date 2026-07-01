export { createAgentDeviceClient } from '../client/client.ts';
export { createLocalArtifactAdapter } from '../io.ts';
export { AppError, isAgentDeviceError, normalizeAgentDeviceError } from '../kernel/errors.ts';
export { centerOfRect } from '../kernel/snapshot.ts';

export type {
  AgentDeviceDaemonTransport,
  AlertCommandResult,
  AppListOptions,
  AppStateCommandResult,
  AppSwitcherCommandResult,
  BackCommandOptions,
  BackCommandResult,
  ClipboardCommandResult,
  HomeCommandResult,
  KeyboardCommandResult,
  RecordOptions,
  RotateCommandOptions,
  RotateCommandResult,
  ScrollOptions,
} from '../client/client.ts';

export type { SnapshotNode } from '../kernel/snapshot.ts';
