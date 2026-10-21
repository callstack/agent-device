import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  createOwnerScopedDeviceClaimReconciler,
  createRecoveryPlatformScope,
  inspectDeviceClaimRecovery,
  type ClaimRecoveryGatewayFactory,
  type OwnerScopedClaimRecoveryComposer,
} from '@agent-device/daemon-contracts/device-claim-recovery';
import {
  releaseProvenStaleDeviceClaims,
  type DeviceClaimSelectors,
  type DeviceClaimStaleReleaseOutcome,
} from '@agent-device/daemon-contracts/device-claims';
import { createPlatformRuntimeGateway } from './platform-runtime.ts';

/**
 * Root composition for owner-scoped claim recovery (ADR 0019 section 1): the daemon owns the
 * recovery transaction and its disposal, and asks root composition only to assemble the local
 * runtime gateway the transaction runs on, because building a gateway is the one act that names
 * platform modules. A local-only gateway per transaction keeps provider runtimes out of recovery —
 * claims exist only for local devices — and instance-scopes every stateful piece the gateway owns,
 * so disposal shuts down only this transaction's handles.
 */
export const createClaimRecoveryGatewayFor =
  (host: HostEnvironment): ClaimRecoveryGatewayFactory =>
  (input) =>
    createPlatformRuntimeGateway({
      host,
      sessionsDir: input.sessionsDir,
      ownedProcesses: input.ownedProcesses,
      resolveSessionArtifacts: input.resolveSessionArtifacts,
    });

/**
 * Daemonless `device release --stale`: settles each provably dead owner
 * through the same owner-scoped reconciliation the daemon uses at `open` and
 * startup — recovery composed from the stale claim's own state dir, resources
 * settled first, claim cleared last — without requiring the (typically dead)
 * owner daemon, or any daemon, to be running.
 */
export async function runStaleDeviceClaimRelease(
  selectors: DeviceClaimSelectors,
  host: HostEnvironment,
  composeRecovery?: OwnerScopedClaimRecoveryComposer,
): Promise<DeviceClaimStaleReleaseOutcome[]> {
  // Settling a transaction can reach runner code; this CLI process runs one host, and the
  // runner reads its configuration from it, entered as the runtime state the daemon route binds.
  const { setAppleRunnerHostEnvironment } =
    await import('@agent-device/platform-apple/runner-owner');
  setAppleRunnerHostEnvironment(host);
  return await releaseProvenStaleDeviceClaims({
    selectors,
    env: host.env,
    reconcile: createOwnerScopedDeviceClaimReconciler({
      scope: createRecoveryPlatformScope(),
      composeGateway: createClaimRecoveryGatewayFor(host),
      composeRecovery,
      beforeGateway: inspectDeviceClaimRecovery,
    }),
  });
}
