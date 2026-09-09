import {
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { SimulatorSnapshotSource } from './snapshot-source-facade.ts';
import type {
  SimulatorSnapshotTarget,
  SimulatorSnapshotTargetResolver,
} from './snapshot-target.ts';

/**
 * What an `open` learned about the app it just launched on a local Simulator: `observable` means
 * the host AX bridge published its tree, so the first observation will not pay a launch
 * transition; `unobservable` means the bridge reported a state that will not clear within its
 * grace (a system dialog, a lost AX server) or the grace ran out; `not-eligible` means the device
 * has no bridge to ask.
 */
export type LaunchObservation = 'observable' | 'unobservable' | 'not-eligible';

export type LaunchObservationPort = Readonly<{
  awaitObservable(
    device: DeviceInfo,
    appBundleId: string,
    signal: AbortSignal,
  ): Promise<LaunchObservation>;
}>;

/**
 * A freshly launched app is not yet the primary foreground owner while SpringBoard animates it
 * in, and its accessibility server registers a moment after its process appears. The bridge
 * reports those states as typed failures. Each code gets its own window, measured from the first
 * failure (the bridge's own cold start may already have consumed the launch) and never extended:
 * a stricter code seen later shrinks the deadline, so an AX-server miss followed by an ownership
 * miss gets the ownership window, and a system dialog still reaches the caller's typed fallback
 * quickly. Every other failure ends the wait at once.
 */
const OBSERVATION_POLL_MS = 150;
const LAUNCH_TRANSITION_WINDOW_MS: ReadonlyMap<string, number> = new Map([
  ['application-element-missing', 5_000],
  ['application-server-unavailable', 5_000],
  ['foreground-owner-unverified', 1_000],
  ['foreground-owner-changed', 1_000],
]);

/** Only iOS Simulators carry the host AX bridge; other Apple simulators observe through XCTest. */
export function hasSimulatorBridge(device: DeviceInfo): boolean {
  return device.platform === 'apple' && device.appleOs === 'ios' && device.kind === 'simulator';
}

export function createLaunchObservationProbe(
  deps: Readonly<{
    source: SimulatorSnapshotSource;
    resolveTarget: SimulatorSnapshotTargetResolver;
    clock: PlatformRuntimeHost['clock'];
    isBridgeDisabled: (target: SimulatorSnapshotTarget) => boolean;
  }>,
): LaunchObservationPort {
  const hint = deriveIosCaptureHint(createIosSnapshotRequest({ depth: 1, interactiveOnly: true }));
  return Object.freeze({
    awaitObservable: async (device, appBundleId, signal) => {
      if (!hasSimulatorBridge(device)) return 'not-eligible';
      let deadline: number | undefined;
      for (;;) {
        const target = await deps.resolveTarget(device, appBundleId, signal).catch(() => undefined);
        signal.throwIfAborted();
        if (!target) return 'unobservable';
        // A generation whose bridge already failed a capture fails this probe the same way, and
        // the codes it fails with are the ones this loop re-reads for seconds. Ask the circuit
        // first; a relaunch carries a new generation, which rebaselines and observes as usual.
        // A skip is reported, because an unresolvable target reaches the same verdict by a
        // different route and only the diagnostic tells the two apart on a live device.
        if (deps.isBridgeDisabled(target)) {
          emitDiagnostic({
            level: 'debug',
            phase: 'ios_launch_observation_skipped',
            data: {
              reason: 'circuit-disabled',
              deviceId: device.id,
              generation: target.generation,
            },
          });
          return 'unobservable';
        }
        const outcome = await deps.source.acquire({ target, hint, signal });
        if (outcome.stage !== 'failed') return 'observable';
        signal.throwIfAborted();
        const windowMs = LAUNCH_TRANSITION_WINDOW_MS.get(outcome.failure.code);
        if (windowMs === undefined) return 'unobservable';
        const now = deps.clock.now();
        deadline = Math.min(deadline ?? Number.POSITIVE_INFINITY, now + windowMs);
        if (now >= deadline) return 'unobservable';
        await deps.clock.sleep(Math.min(OBSERVATION_POLL_MS, deadline - now), signal);
      }
    },
  });
}
