import {
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type {
  PostOpenObservation,
  PostOpenObservationFailure,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import type { SimulatorSnapshotSource } from './snapshot-source-facade.ts';
import {
  isSimulatorTargetDiscoveryPending,
  isSimulatorTargetNotRunning,
  type SimulatorSnapshotTarget,
  type SimulatorSnapshotTargetResolver,
} from './snapshot-target.ts';

/**
 * What a local Simulator's host AX bridge learned about a launched app. `unobservable` is only the
 * app's own state: no running process, or a launch-transition code whose window ran out.
 * `probe-failed` is a bridge that could not observe: an unresolvable target, an open circuit, or
 * any other bridge failure, with the failure that stopped it.
 *
 * `unobservable` says *how* it was proven, because only one proof is safe to act on: a settled
 * `launchctl list` with no job for the app proves no process, while an expired launch-transition
 * window leaves a process that may still be coming up. A caller relaunching a held URL acts on the
 * first proof only.
 */
export type LaunchObservation =
  | Readonly<{ observation: Extract<PostOpenObservation, 'observable' | 'not-eligible'> }>
  | Readonly<{ observation: 'unobservable'; proof: NoRunningProcessProof }>
  | Readonly<{ observation: 'probe-failed'; failure: PostOpenObservationFailure }>;

/** Whether a settled target discovery, rather than a window running out, proved no process. */
export type NoRunningProcessProof = 'no-running-process' | 'launch-transition';

/** Whether an observation proves the app has no running process on the Simulator. */
export function isProvenNotRunning(observed: LaunchObservation | undefined): boolean {
  return observed?.observation === 'unobservable' && observed.proof === 'no-running-process';
}

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
      if (!hasSimulatorBridge(device)) return { observation: 'not-eligible' };
      let deadline: number | undefined;
      for (;;) {
        const resolved = await resolveLaunchedTarget(
          deps.resolveTarget,
          device,
          appBundleId,
          signal,
        );
        if ('verdict' in resolved) return resolved.verdict;
        const { target } = resolved;
        // A generation whose bridge already failed a capture fails this probe the same way, and
        // the codes it fails with are the ones this loop re-reads for seconds. Ask the circuit
        // first; a relaunch carries a new generation, which rebaselines and observes as usual.
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
          return probeFailed({ source: 'circuit' });
        }
        const outcome = await deps.source.acquire({ target, hint, signal });
        if (outcome.stage !== 'failed') return { observation: 'observable' };
        signal.throwIfAborted();
        const { kind, code } = outcome.failure;
        const windowMs = LAUNCH_TRANSITION_WINDOW_MS.get(code);
        if (windowMs === undefined) return probeFailed({ source: 'bridge', kind, code });
        const now = deps.clock.now();
        deadline = Math.min(deadline ?? Number.POSITIVE_INFINITY, now + windowMs);
        if (now >= deadline) return { observation: 'unobservable', proof: 'launch-transition' };
        await deps.clock.sleep(Math.min(OBSERVATION_POLL_MS, deadline - now), signal);
      }
    },
  });
}

function probeFailed(failure: PostOpenObservationFailure): LaunchObservation {
  return { observation: 'probe-failed', failure };
}

/**
 * The launched app's bridge target, or the verdict its resolution already decides: an app with no
 * running process is `unobservable` (a launch SpringBoard still holds has none), any other
 * resolution failure is `probe-failed`. A discovery that is still running has not answered yet,
 * so the probe keeps joining it one wait slice at a time until the discovery's own deadline
 * settles it. Returning early would hand the discovery, the bridge preparation and the first
 * bridge connection to the first observation after the open, which pays them inside its own
 * budget.
 */
async function resolveLaunchedTarget(
  resolveTarget: SimulatorSnapshotTargetResolver,
  device: DeviceInfo,
  appBundleId: string,
  signal: AbortSignal,
): Promise<
  Readonly<{ target: SimulatorSnapshotTarget }> | Readonly<{ verdict: LaunchObservation }>
> {
  for (;;) {
    try {
      return { target: await resolveTarget(device, appBundleId, signal) };
    } catch (error) {
      signal.throwIfAborted();
      if (isSimulatorTargetDiscoveryPending(error)) continue;
      if (isSimulatorTargetNotRunning(error))
        return { verdict: { observation: 'unobservable', proof: 'no-running-process' } };
      const { code, details } = normalizeError(error);
      const reason = details?.reason;
      return {
        verdict: probeFailed(
          typeof reason === 'string'
            ? { source: 'target', code, reason }
            : { source: 'target', code },
        ),
      };
    }
  }
}
