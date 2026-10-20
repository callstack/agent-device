import type { AgentDeviceHost, StartAgentDeviceOptions } from './host-types.ts';

export { createAgentDeviceClient } from '../agent-device-client.ts';
export type { AgentDeviceHost, StartAgentDeviceOptions } from './host-types.ts';

/** Starts an in-process daemon, loading its runtime only when called. */
export async function startAgentDevice(options: StartAgentDeviceOptions): Promise<AgentDeviceHost> {
  const { startAgentDevice } = await import('../host.ts');
  return await startAgentDevice(options);
}
export { ensureDaemon } from './ensure-daemon.ts';
export { createLocalArtifactAdapter } from '../io.ts';
export {
  AppError,
  isAgentDeviceError,
  normalizeAgentDeviceError,
} from '@agent-device/kernel/errors';
export { centerOfRect } from '@agent-device/kernel/snapshot';
export { isUnreadableCaptureContentError } from '@agent-device/contracts/android-snapshot-quality';

export type * from '../client/client-types.ts';
export type {
  DaemonConnection,
  DaemonIdentity,
  DaemonLifecycle,
  EnsureDaemonOptions,
} from '@agent-device/contracts/client';
// Two results `client-types.ts` imports for its signatures without re-exporting them.
export type {
  AgentArtifactsResult,
  CloudProviderSessionResult,
} from '@agent-device/contracts/observability';
export type {
  AppErrorCode,
  AppErrorDetails,
  ErrorCause,
  KnownAppErrorCode,
  NormalizedError,
} from '@agent-device/kernel/errors';
export type {
  Point,
  RawSnapshotNode,
  Rect,
  SnapshotNode,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
