import { createPlatformRuntimeGateway } from './platform-runtime.ts';
import type { ClaimRecoveryGatewayFactory } from './daemon/device/claim-recovery-gateway.ts';

/**
 * Root composition for owner-scoped claim recovery (ADR 0019 section 1): the daemon owns the
 * recovery transaction and its disposal, and asks root composition only to assemble the local
 * runtime gateway the transaction runs on, because building a gateway is the one act that names
 * platform modules. A local-only gateway per transaction keeps provider runtimes out of recovery —
 * claims exist only for local devices — and instance-scopes every stateful piece the gateway owns,
 * so disposal shuts down only this transaction's handles.
 */
export const createClaimRecoveryGateway: ClaimRecoveryGatewayFactory = (input) =>
  createPlatformRuntimeGateway({
    sessionsDir: input.sessionsDir,
    ownedProcesses: input.ownedProcesses,
    resolveSessionArtifacts: input.resolveSessionArtifacts,
  });
