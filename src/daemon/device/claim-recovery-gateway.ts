import type { AppLogSessionArtifacts } from '@agent-device/contracts/app-log-runtime';
import type { OwnedProcessRecordWriter } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceRuntimeGateway } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';

/**
 * The per-transaction inputs a stale-claim recovery gateway is built from. Every path names the
 * DEAD owner's state dir, never the reconciling process's: recording cleanup clears owned-process
 * records by bare session id through the composed store, so one caller-scoped store would let a
 * foreign claim's recovery clear a same-named live session's records (#2168).
 */
export type ClaimRecoveryGatewayInput = Readonly<{
  /** The dead owner's daemon state dir, resolved from its own claim record. */
  stateDir: string;
  sessionsDir: string;
  ownedProcesses?: OwnedProcessRecordWriter;
  resolveSessionArtifacts(sessionId: string): AppLogSessionArtifacts;
}>;

/**
 * The one gateway act the daemon asks root composition to perform for it: assemble the local
 * runtime gateway a recovery transaction runs on. Building a gateway names platform modules, so
 * the daemon declares only this question and never answers it (ADR 0019).
 */
export type ClaimRecoveryGatewayFactory = (
  input: ClaimRecoveryGatewayInput,
) => DeviceRuntimeGateway<PlatformRuntimeOperations>;
