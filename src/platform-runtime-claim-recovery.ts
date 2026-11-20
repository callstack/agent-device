import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  createClaimRecoveryDisposalTracker,
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
import type { PlatformModuleSelection } from '@agent-device/contracts/platform-plugin';
import type { InstalledPlatforms } from './platform-runtime/installed-platforms.ts';
import { createPlatformRuntimeGateway } from './platform-runtime.ts';

/**
 * Root composition for owner-scoped claim recovery (ADR 0019 section 11): the daemon owns the
 * recovery transaction and its disposal, and asks root composition only to assemble the local
 * runtime gateway the transaction runs on, because building a gateway is the one act that names
 * platform modules. A local-only gateway per transaction keeps provider runtimes out of recovery —
 * claims exist only for local devices — and instance-scopes every stateful piece the gateway owns,
 * so disposal shuts down only this transaction's handles. `platforms` is the process's one platform
 * selection, so recovery binds an installed optional family through the same registration every
 * other request of this process uses.
 */
export const createClaimRecoveryGatewayFor =
  (host: HostEnvironment, platforms: PlatformModuleSelection): ClaimRecoveryGatewayFactory =>
  (input) =>
    createPlatformRuntimeGateway({
      host,
      stateDir: input.stateDir,
      platforms,
      sessionsDir: input.sessionsDir,
      ownedProcesses: input.ownedProcesses,
      resolveSessionArtifacts: input.resolveSessionArtifacts,
    });

type ClaimRecoveryGateway = ReturnType<ClaimRecoveryGatewayFactory>;

/**
 * A gateway composed on the first bind or fact read. A release that settles no durable resource
 * through a runtime never composes it, so it starts no plugin.
 */
function createDeferredGateway(compose: () => Promise<ClaimRecoveryGateway>): ClaimRecoveryGateway {
  let composed: Promise<ClaimRecoveryGateway> | undefined;
  const gateway = (): Promise<ClaimRecoveryGateway> => (composed ??= compose());
  return Object.freeze({
    inspectFacts: async (device) => await (await gateway()).inspectFacts(device),
    bind: async (request) => await (await gateway()).bind(request),
    // A composition that failed owns nothing to shut down; its error already failed the bind.
    shutdown: async () =>
      await composed?.then(
        (started) => started.shutdown(),
        () => undefined,
      ),
  });
}

/**
 * Daemonless `device release --stale`: settles each provably dead owner
 * through the same owner-scoped reconciliation the daemon uses at `open` and
 * startup — recovery composed from the stale claim's own state dir, resources
 * settled first, claim cleared last — without requiring the (typically dead)
 * owner daemon, or any daemon, to be running.
 *
 * The platform selection is this process's, as in the daemon: one plugin registry for the whole
 * run, started from `stateDir` (the caller's state dir) on the first gateway use and closed when
 * the run ends. Only the gateway's session paths and process records follow the stale owner.
 */
export async function runStaleDeviceClaimRelease(
  selectors: DeviceClaimSelectors,
  host: HostEnvironment,
  options: Readonly<{
    stateDir?: string;
    composeRecovery?: OwnerScopedClaimRecoveryComposer;
    afterOutcomes?: (outcomes: DeviceClaimStaleReleaseOutcome[]) => Promise<void> | void;
    disposeBudgetMs?: number;
  }> = {},
): Promise<DeviceClaimStaleReleaseOutcome[]> {
  // Settling a transaction can reach runner code; this CLI process runs one host, and the
  // runner reads its configuration from it, entered as the runtime state the daemon route binds.
  const { setAppleRunnerHostEnvironment } =
    await import('@agent-device/platform-apple/runner-owner');
  setAppleRunnerHostEnvironment(host);
  let installed: Promise<InstalledPlatforms> | undefined;
  const startInstalled = (): Promise<InstalledPlatforms> =>
    (installed ??= import('./platform-runtime/installed-platforms.ts').then(
      ({ startInstalledPlatforms }) => startInstalledPlatforms(host, options.stateDir),
    ));
  const disposals = createClaimRecoveryDisposalTracker();
  try {
    const outcomes = await releaseProvenStaleDeviceClaims({
      selectors,
      env: host.env,
      reconcile: createOwnerScopedDeviceClaimReconciler({
        scope: createRecoveryPlatformScope(),
        composeGateway: (input) =>
          createDeferredGateway(async () =>
            createClaimRecoveryGatewayFor(host, (await startInstalled()).platforms)(input),
          ),
        composeRecovery: options.composeRecovery,
        beforeGateway: inspectDeviceClaimRecovery,
        trackDisposal: disposals.track,
        disposeBudgetMs: options.disposeBudgetMs,
      }),
    });
    await options.afterOutcomes?.(outcomes);
    return outcomes;
  } finally {
    // Keep the CLI alive while a tracked disposal awaits an unref'd handle or timer.
    const keepAlive = setInterval(() => {}, 60_000);
    try {
      await disposals.drain();
    } finally {
      clearInterval(keepAlive);
    }
    // A registry that failed to start set nothing up, and its error already failed the bind.
    await installed?.then(
      (started) => started.close(),
      () => undefined,
    );
  }
}
