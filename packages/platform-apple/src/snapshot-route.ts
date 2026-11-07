import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import {
  createSnapshotRouter,
  type SnapshotRouter,
} from '@agent-device/capture-kit/snapshot-router';
import type { SystemSurfaceForegroundProbe } from '@agent-device/capture-kit/snapshot-source-channel';
import {
  createSimulatorSnapshotSource,
  type SimulatorSnapshotSource,
} from './snapshot-source-facade.ts';
import {
  createLaunchObservationProbe,
  hasSimulatorBridge,
  type LaunchObservationPort,
} from './snapshot-observability.ts';
import {
  createSimulatorSnapshotTargetResolver,
  isSimulatorTargetDiscoveryPending,
  type SimulatorSnapshotTarget,
  type SimulatorSnapshotTargetResolver,
} from './snapshot-target.ts';
import { createSystemSurfaceForegroundProbe } from './system-surface-foreground.ts';

export type AppleSnapshotRoute = LaunchObservationPort & Omit<SnapshotRouter, 'isBridgeDisabled'>;

/**
 * The local iOS Simulator's snapshot channel, bound to the snapshot router: the guest bridge process
 * the host starts. Its resolver verifies a cached target's process identity on every resolution, so
 * the channel declares no `refreshTarget`.
 *
 * A target discovery still in flight is not a failure while no runner is live: the XCTest fallback
 * would first wait for a runner start, and #2198 keeps observation off that wait, so the capture
 * joins the single-flight discovery. A runner that is already live answers at once, so there the
 * fallback remains the cheaper route (#2331).
 */
export function createAppleSnapshotRoute(
  host: PlatformRuntimeHost,
  options: Readonly<{
    source?: SimulatorSnapshotSource;
    resolveTarget?: SimulatorSnapshotTargetResolver;
    systemSurfaceForeground?: SystemSurfaceForegroundProbe;
  }> = {},
): AppleSnapshotRoute {
  const source = options.source ?? createSimulatorSnapshotSource(host.hostEnvironment);
  const resolveTarget = options.resolveTarget ?? createSimulatorSnapshotTargetResolver();
  const router = createSnapshotRouter<SimulatorSnapshotTarget>(
    host,
    {
      source,
      servesDevice: hasSimulatorBridge,
      resolveTarget,
      awaitsDiscovery: async (error, device, execution) =>
        isSimulatorTargetDiscoveryPending(error) &&
        !(await host.appleApplications.hasLiveRunnerSession(device, execution)),
      observeOnlySupported: true,
    },
    options.systemSurfaceForeground ?? createSystemSurfaceForegroundProbe(),
  );
  const observation = createLaunchObservationProbe({
    source,
    resolveTarget,
    clock: host.clock,
    isBridgeDisabled: router.isBridgeDisabled,
  });
  return Object.freeze({
    awaitObservable: observation.awaitObservable,
    capture: router.capture,
    shutdown: router.shutdown,
  });
}
