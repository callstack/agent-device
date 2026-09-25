export { createAgentDeviceClient } from '../agent-device-client.ts';
export { createLocalArtifactAdapter } from '../io.ts';
export {
  AppError,
  isAgentDeviceError,
  normalizeAgentDeviceError,
} from '@agent-device/kernel/errors';
export { centerOfRect } from '@agent-device/kernel/snapshot';

// The types the root's two functions are written in. `createAgentDeviceClient` returns
// `AgentDeviceClient`, whose every option and result type is a named type of
// `client-types.ts`; until now a consumer reached them only through
// `ReturnType<typeof createAgentDeviceClient>` and `Awaited<ReturnType<...>>`, and typed the
// nodes a snapshot returns by hand.
export type * from '../client/client-types.ts';
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
