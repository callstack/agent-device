import { randomUUID } from 'node:crypto';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type {
  CaptureSnapshotInput,
  SnapshotResult,
  SnapshotRuntimeAcquiredResult,
} from '@agent-device/contracts/snapshot-runtime';
import type {
  CaptureHint,
  IosAcquisitionResidue,
  IosSnapshotComparisonIdentity,
  IosSnapshotLineage,
} from '@agent-device/contracts/ios-snapshot';
import {
  buildIosSnapshotPresentationKey,
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import { IOS_SYSTEM_SURFACE_HOSTS } from '@agent-device/contracts/ios-system-surface';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  createSimulatorSnapshotSource,
  type SimulatorSnapshotSource,
  type SnapshotSourceFailure,
  type SnapshotSourceOutcome,
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
import { SnapshotSourceError } from './snapshot-source/errors.ts';
import {
  createSystemSurfaceForegroundProbe,
  type SystemSurfaceForegroundProbe,
  type SystemSurfaceForegroundReading,
} from './system-surface-foreground.ts';
import {
  bridgeFailureDisposition,
  type BridgeFailureDisposition,
  type BridgeFallbackDisposition,
  type CaptureScopedConsequence,
} from './snapshot-route-failure-policy.ts';

type SnapshotFallback = (input: CaptureSnapshotInput) => Promise<SnapshotResult>;

/** Why this capture left the bridge: a system surface the bridge cannot see was on screen. */
const SYSTEM_SURFACE_PRESENTED = 'system-surface-presented';

/**
 * The same decision, against the bridge's one documented false positive: the surface host process
 * outlives the dismissal of its sheet, so the bridge refused a surface the runner then did not serve.
 */
const SYSTEM_SURFACE_HOST_LINGERING = 'system-surface-host-lingering';

/**
 * Why this capture left the bridge. The literal causes are route decisions, separate from the
 * guest's failure taxonomy; the disposition is the one classification a source failure receives in
 * `fallbackAfterFailure`. Circuit scope and warning wording consume that one value (#3874, #3895).
 */
type FallbackReason =
  | BridgeFallbackDisposition
  | typeof SYSTEM_SURFACE_PRESENTED
  | typeof SYSTEM_SURFACE_HOST_LINGERING
  | 'system-surface-host-unverified'
  | 'target-resolution-failed'
  | 'circuit-disabled';

export type AppleSnapshotRoute = LaunchObservationPort & SnapshotBridgeRoute;

export type SnapshotBridgeRoute = Readonly<{
  capture(
    device: DeviceInfo,
    input: CaptureSnapshotInput,
    signal: AbortSignal,
    fallback: SnapshotFallback,
  ): Promise<SnapshotResult>;
  shutdown(): Promise<void>;
}>;

/** The app generation a bridge read is planned against. */
type SnapshotBridgeRouteTarget = Readonly<{
  pid: number;
  generation: string;
  targetId: string;
}>;

/**
 * One way to reach the bridge reader on a device: the source that reads, and how the app generation it
 * reads is named. A local Simulator reaches it through a guest process the host starts; a Simulator
 * whose host cannot start one reaches it through the XCTest runner.
 */
export type SnapshotBridgeChannel<Target extends SnapshotBridgeRouteTarget> = Readonly<{
  source: Readonly<{
    acquire(
      request: Readonly<{
        target: Target;
        hint: CaptureHint;
        signal?: AbortSignal;
        surfaceHostExecutables?: readonly string[];
      }>,
    ): Promise<SnapshotSourceOutcome>;
    close(): Promise<void>;
  }>;
  resolveTarget(
    device: DeviceInfo,
    appBundleId: string,
    signal: AbortSignal,
    refresh?: 'refresh',
  ): Promise<Target>;
  /** Whether a resolver failure only says discovery is still running, so a capture may wait on it. */
  isDiscoveryPending?(error: unknown): boolean;
  refreshTarget?(device: DeviceInfo, appBundleId: string, signal: AbortSignal): Promise<Target>;
  observeOnlySupported?: boolean;
  sessionChanged?(): void;
}>;

/** What the route reads from the platform host: presentation and runner liveness only. */
export type SnapshotBridgeRouteHost = Readonly<{
  snapshot: Pick<PlatformRuntimeHost['snapshot'], 'presentIosAcquisition'>;
  appleApplications: Pick<PlatformRuntimeHost['appleApplications'], 'hasLiveRunnerSession'>;
}>;

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
  const route = createSnapshotBridgeRouteCore<SimulatorSnapshotTarget>(
    host,
    {
      source,
      resolveTarget,
      isDiscoveryPending: isSimulatorTargetDiscoveryPending,
    },
    options.systemSurfaceForeground ?? createSystemSurfaceForegroundProbe(),
  );
  const observation = createLaunchObservationProbe({
    source,
    resolveTarget,
    clock: host.clock,
    isBridgeDisabled: route.isBridgeDisabled,
  });
  return Object.freeze({
    awaitObservable: observation.awaitObservable,
    capture: route.capture,
    shutdown: route.shutdown,
  });
}

/**
 * The bridge route for a Simulator whose host reaches the reader through another channel. It owns the
 * same decisions as the local route: system-surface routing, the per-generation circuit, and the one
 * typed XCTest fallback.
 */
export function createSnapshotBridgeRoute<Target extends SnapshotBridgeRouteTarget>(
  host: SnapshotBridgeRouteHost,
  channel: SnapshotBridgeChannel<Target>,
  surfaceForeground: SystemSurfaceForegroundProbe,
): SnapshotBridgeRoute {
  const route = createSnapshotBridgeRouteCore(host, channel, surfaceForeground);
  return Object.freeze({
    capture: route.capture,
    shutdown: route.shutdown,
  });
}

function createSnapshotBridgeRouteCore<Target extends SnapshotBridgeRouteTarget>(
  host: SnapshotBridgeRouteHost,
  channel: SnapshotBridgeChannel<Target>,
  surfaceForeground: SystemSurfaceForegroundProbe,
) {
  const { source, resolveTarget } = channel;
  const freshCircuit = (sessionId?: string) => ({
    sessionId,
    disabledGenerations: new Set<string>(),
    latestGeneration: new Map<string, string>(),
    sessionDisabled: false,
  });
  let currentCircuit = freshCircuit();
  const isDisabledIn = (circuit: typeof currentCircuit, target: SnapshotBridgeRouteTarget) => {
    rebaselineGeneration(target, circuit.latestGeneration, circuit.disabledGenerations);
    return circuit.disabledGenerations.has(generationKey(target));
  };
  /**
   * The circuit a capture writes its refusals to. A capture writes through the returned object, so
   * it must be the circuit object itself, never a copy: when it is `currentCircuit`, the next capture
   * reads what this one wrote. A capture that read through a session another capture already
   * replaced keeps its starting circuit, so its late writes land in the discarded object.
   */
  const circuitForProbe = (
    startingCircuit: typeof currentCircuit,
    probeResult: SystemSurfaceForegroundReading,
    device: DeviceInfo,
  ): typeof currentCircuit => {
    const probedSessionId = channel.sessionChanged ? probeResult.sessionId : undefined;
    if (probedSessionId === undefined) return startingCircuit;
    if (currentCircuit !== startingCircuit) {
      return probedSessionId === currentCircuit.sessionId ? currentCircuit : startingCircuit;
    }
    if (probedSessionId === startingCircuit.sessionId) return startingCircuit;
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_snapshot_route_runner_session_changed',
      data: {
        deviceId: device.id,
        previousSessionId: startingCircuit.sessionId,
        sessionId: probedSessionId,
      },
    });
    currentCircuit = freshCircuit(probedSessionId);
    channel.sessionChanged?.();
    return currentCircuit;
  };
  /**
   * Records `target` as the newest generation of its app — which clears the circuit an earlier
   * generation opened — and reports whether the bridge is disabled for it. Both a capture and the
   * launch-observation probe ask before they spend a bridge round trip, so one generation's
   * failure is paid once rather than once per route (#2198, #2199).
   */
  const isBridgeDisabled = (target: SnapshotBridgeRouteTarget): boolean =>
    isDisabledIn(currentCircuit, target);

  return {
    isBridgeDisabled,
    shutdown: async () => await source.close(),
    capture: async (
      device: DeviceInfo,
      input: CaptureSnapshotInput,
      signal: AbortSignal,
      fallback: SnapshotFallback,
    ): Promise<SnapshotResult> => {
      const eligibility = routeEligibility(device, input, channel);
      if (eligibility !== 'bridge') {
        return await settleFallback(device, input, fallback, { kind: eligibility });
      }
      // A system surface (e.g. the web sign-in sheet) presented over the app is invisible to the
      // host AX bridge — the app is still the AX primaryApp, so the bridge would serve the occluded
      // app tree as if healthy (#2438). The XCTest runner can see and drive the surface, so route
      // this capture to it. The runner serves the surface only while it is genuinely foreground and
      // otherwise serves the app, so this is correct even while a dismissed host lingers.
      //
      // A ready runner answers first, with the foreground state of every registered host: the
      // predicate it serves a surface by, read in a few milliseconds. When it cannot answer, the
      // bridge itself refuses the capture while a host process runs for this Simulator.
      const startingCircuit = currentCircuit;
      const probeResult = await readSurfaceForeground(device, input, signal, surfaceForeground);
      const circuit = circuitForProbe(startingCircuit, probeResult, device);
      const { foreground } = probeResult;
      const captureBridgeDisabled = (target: SnapshotBridgeRouteTarget) =>
        isDisabledIn(circuit, target);
      if (foreground !== 'background' && foreground !== 'unknown') {
        return await settleFallback(device, input, fallback, {
          kind: 'surface',
          detectedHost: foreground.host.bundleId,
        });
      }
      if (circuit.sessionDisabled) {
        emitRouteDiagnostic('bridge-reader-wedged', device);
        return await settleFallback(device, input, fallback, {
          kind: 'reason',
          lineage: appLineage(device.id, input),
          reason: { scope: 'runner-session', code: 'bridge-reader-wedged' },
          residue: [unknownGenerationResidue()],
        });
      }
      let target: Target;
      try {
        target = await resolveCaptureTarget(
          host,
          channel,
          device,
          input,
          signal,
          captureBridgeDisabled,
        );
      } catch (error) {
        rethrowIfResolutionCancelled(signal, error);
        const reason = targetFailureReason(error, device, circuit);
        // The app's current generation is unknown, so the capture names none.
        return await settleFallback(device, input, fallback, {
          kind: 'reason',
          lineage: appLineage(device.id, input),
          reason,
          residue: [unknownGenerationResidue()],
        });
      }
      if (captureBridgeDisabled(target)) {
        emitRouteDiagnostic('circuit-disabled', device, target.generation);
        return await settleFallback(device, input, fallback, {
          kind: 'reason',
          lineage: target,
          reason: 'circuit-disabled',
        });
      }

      const request = requestFor(input);
      const outcome = await source.acquire({
        target,
        hint: deriveIosCaptureHint(request),
        signal,
        // A runner that read every host in the background keeps a lingering host on the bridge.
        ...(foreground === 'unknown' ? { surfaceHostExecutables: SURFACE_HOST_EXECUTABLES } : {}),
      });
      if (outcome.stage === 'failed') {
        rethrowCancelledFailure(outcome.failure, signal);
        const disposition = settleRunnerSessionRefusal(
          circuit,
          bridgeFailureDisposition(outcome.failure),
        );
        if ('surfaceHost' in disposition) {
          return await fallbackForSurfaceHost(device, input, fallback, target, disposition);
        }
        const fallbackIdentity = await resolveFailureFallbackIdentity(
          outcome.failure,
          target,
          device,
          input.options!.appBundleId!,
          signal,
          resolveTarget,
        );
        return await fallbackAfterFailure(
          device,
          input,
          fallback,
          target,
          fallbackIdentity,
          outcome.failure,
          disposition,
          circuit.disabledGenerations,
        );
      }
      try {
        return await withDiagnosticTimer(
          'ios.snapshot-source.present',
          async () =>
            await host.snapshot.presentIosAcquisition(
              outcome as SnapshotRuntimeAcquiredResult,
              input.options,
            ),
          { producer: 'simulator-ax-bridge' },
        );
      } catch (error) {
        const failure = { kind: 'malformed-tree', code: 'presentation-invariant' } as const;
        return await fallbackAfterFailure(
          device,
          input,
          fallback,
          target,
          { lineage: target, residue: [] },
          failure,
          // A tree the presenter cannot publish is app evidence, so it retires the generation.
          { scope: 'generation', code: failure.code },
          circuit.disabledGenerations,
          error,
        );
      }
    },
  };
}

function rethrowCancelledFailure(failure: SnapshotSourceFailure, signal: AbortSignal): void {
  if (failure.kind !== 'cancelled') return;
  signal.throwIfAborted();
  throw new AppError('COMMAND_FAILED', 'Simulator AX snapshot acquisition was cancelled.', {
    reason: failure.code,
    ...failure.details,
  });
}

function targetFailureReason(
  error: unknown,
  device: DeviceInfo,
  circuit: RunnerSessionCircuit,
): FallbackReason {
  const disposition =
    error instanceof SnapshotSourceError
      ? bridgeFailureDisposition({ kind: error.failureKind, code: error.failureCode })
      : undefined;
  emitRouteDiagnostic(
    disposition?.scope === 'runner-session' ? disposition.code : 'target-resolution-failed',
    device,
    undefined,
    error,
  );
  if (disposition?.scope === 'runner-session')
    return settleRunnerSessionRefusal(circuit, disposition);
  return 'target-resolution-failed';
}

type RunnerSessionCircuit = { readonly sessionId?: string; sessionDisabled: boolean };

/**
 * Retires the bridge for the circuit's runner session when the circuit names that session; a later
 * probe that names another session replaces the circuit and clears it. A circuit with no session id
 * has nothing to tie the retirement to, so there the refusal speaks for this capture only, and its
 * warning says so.
 */
function settleRunnerSessionRefusal<Disposition extends BridgeFailureDisposition>(
  circuit: RunnerSessionCircuit,
  disposition: Disposition,
): Disposition | Readonly<{ scope: 'capture'; code: string; consequence: 'bridge-read-busy' }> {
  if (disposition.scope !== 'runner-session') return disposition;
  if (circuit.sessionId === undefined) {
    return { scope: 'capture', code: disposition.code, consequence: 'bridge-read-busy' };
  }
  circuit.sessionDisabled = true;
  return disposition;
}

const SURFACE_HOST_EXECUTABLES = IOS_SYSTEM_SURFACE_HOSTS.map((host) => host.processExecutable);

/**
 * The live runner's read of every registered host's foreground state. A host process outlives what
 * it presented, so this read rather than the bridge's process check decides whether a lingering host
 * keeps a capture off the bridge. `background` is recorded, because it is the answer that keeps the
 * bridge while a host process may still be running.
 */
async function readSurfaceForeground(
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  signal: AbortSignal,
  probe: SystemSurfaceForegroundProbe,
): Promise<SystemSurfaceForegroundReading> {
  const requestId = input.execution?.requestId;
  const foreground = await probe(device, { signal, ...(requestId ? { requestId } : {}) });
  if (foreground.foreground === 'background') {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_snapshot_route_surface_host_background',
      data: { deviceId: device.id },
    });
  }
  return foreground;
}

/**
 * A discovery still in flight is not a failure while no runner can answer instead. The XCTest
 * fallback would first wait for a runner start, and #2198 keeps observation off that wait, so the
 * capture stays on the single-flight discovery: each turn waits one discovery slice, and the
 * discovery's own deadline or the request signal ends the loop. A runner that is already live
 * answers at once, so there the fallback remains the cheaper route (#2331).
 */
async function resolveTargetForObservation<Target extends SnapshotBridgeRouteTarget>(
  host: SnapshotBridgeRouteHost,
  channel: SnapshotBridgeChannel<Target>,
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  signal: AbortSignal,
): Promise<Target> {
  const appBundleId = input.options!.appBundleId!;
  for (;;) {
    try {
      return await channel.resolveTarget(device, appBundleId, signal);
    } catch (error) {
      if (!channel.isDiscoveryPending?.(error)) throw error;
      const execution = { requestId: input.execution?.requestId };
      if (await host.appleApplications.hasLiveRunnerSession(device, execution)) throw error;
    }
  }
}

/**
 * The target this capture is planned against. While a generation's circuit is open no read meets a
 * newer process, so a channel that caches targets is asked again before the circuit is trusted:
 * otherwise a relaunched app would stay off the bridge for good. The fresh target rebaselines the
 * circuit. A refresh that fails is a resolution failure: the capture names no generation.
 */
async function resolveCaptureTarget<Target extends SnapshotBridgeRouteTarget>(
  host: SnapshotBridgeRouteHost,
  channel: SnapshotBridgeChannel<Target>,
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  signal: AbortSignal,
  isBridgeDisabled: (target: SnapshotBridgeRouteTarget) => boolean,
): Promise<Target> {
  const target = await resolveTargetForObservation(host, channel, device, input, signal);
  if (!channel.refreshTarget || !isBridgeDisabled(target)) return target;
  // A refresh that fails leaves the channel's cached target for its circuit, but this capture cannot
  // claim that generation: the app may have relaunched. The failure reaches the caller, which
  // publishes the capture under an unknown generation.
  return await channel.refreshTarget(device, input.options!.appBundleId!, signal);
}

/**
 * A cancelled target resolution rethrows the resolver's own cancellation, which names the readiness
 * phase only when the resolver was waiting on a running discovery.
 */
function rethrowIfResolutionCancelled(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) throw isRequestCanceledError(error) ? error : signal.reason;
}

function routeEligibility<Target extends SnapshotBridgeRouteTarget>(
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  channel: SnapshotBridgeChannel<Target>,
): 'bridge' | 'direct' | 'off-route' {
  if (input.options?.observeOnly && channel.observeOnlySupported === false) return 'direct';
  return hasSimulatorBridge(device) &&
    Boolean(input.options?.appBundleId) &&
    input.options?.customActions !== true &&
    input.options?.preferredBackend === undefined
    ? 'bridge'
    : 'off-route';
}

async function fallbackForSurfaceHost(
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  fallback: SnapshotFallback,
  target: SnapshotBridgeRouteTarget,
  disposition: Extract<
    ReturnType<typeof bridgeFailureDisposition>,
    { consequence: 'system-surface-host' }
  >,
): Promise<SnapshotResult> {
  if (disposition.surfaceHost !== 'unverified') {
    return await settleFallback(device, input, fallback, {
      kind: 'surface',
      detectedHost: disposition.surfaceHost.bundleId,
    });
  }
  return await settleFallback(device, input, fallback, {
    kind: 'reason',
    lineage: target,
    reason: 'system-surface-host-unverified',
  });
}

async function fallbackAfterFailure(
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  fallback: SnapshotFallback,
  failedTarget: SnapshotBridgeRouteTarget,
  identity: FallbackIdentity,
  failure: SnapshotSourceFailure,
  disposition: BridgeFallbackDisposition,
  disabledGenerations: Set<string>,
  cause?: unknown,
): Promise<SnapshotResult> {
  if (disposition.scope === 'generation') disabledGenerations.add(generationKey(failedTarget));
  emitRouteDiagnostic(failure.code, device, failedTarget.generation, cause, failure.details);
  return await settleFallback(device, input, fallback, {
    kind: 'reason',
    lineage: identity.lineage,
    reason: disposition,
    residue: identity.residue,
  });
}

type FallbackPlan =
  | Readonly<{ kind: 'direct' }>
  | Readonly<{ kind: 'off-route' }>
  | Readonly<{ kind: 'surface'; detectedHost: string }>
  | Readonly<{
      kind: 'reason';
      lineage: IosSnapshotLineage;
      reason: FallbackReason;
      residue?: readonly IosAcquisitionResidue[];
    }>;

async function settleFallback(
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  fallback: SnapshotFallback,
  plan: FallbackPlan,
): Promise<SnapshotResult> {
  const result = await fallback(input);
  if (plan.kind === 'direct') return result;
  if (plan.kind === 'off-route') {
    if (!result.systemSurface) return result;
    return {
      ...result,
      comparisonIdentity: runnerComparisonIdentity(
        surfaceLineage(device.id, result.systemSurface.bundleId),
        requestFor(input),
        [],
      ),
    };
  }
  if (plan.kind === 'surface') {
    const reason = result.systemSurface ? SYSTEM_SURFACE_PRESENTED : SYSTEM_SURFACE_HOST_LINGERING;
    if (!result.systemSurface)
      emitRouteDiagnostic(reason, device, undefined, undefined, {
        detectedHost: plan.detectedHost,
      });
    return stampFallback(
      device.id,
      result,
      appLineage(device.id, input),
      requestFor(input),
      reason,
    );
  }
  return stampFallback(
    device.id,
    result,
    plan.lineage,
    requestFor(input),
    plan.reason,
    plan.residue,
  );
}

/**
 * The one place a runner fallback's identity is decided. The runner stamps the surface it actually
 * served onto its result, and that stamp is the authority over the app lineage the route planned:
 * a capture OF a system surface is identified by that surface whatever reason sent the route here.
 * Deriving this per call site is what let `circuit-disabled` stamp app lineage onto a sheet capture,
 * so a sheet and the app could compare equal and corroborate a tap across the two (#2438).
 *
 * `reason` survives either way — why the bridge was skipped is independent of what the runner found.
 * App-generation evidence leaves with the app lineage it describes: a surface is not an app
 * generation, and a per-capture residue id would make two captures of the same sheet incomparable
 * with each other too.
 */
function stampFallback(
  deviceId: string,
  result: SnapshotResult,
  lineage: IosSnapshotLineage,
  request: ReturnType<typeof createIosSnapshotRequest>,
  reason: FallbackReason,
  residue: readonly IosAcquisitionResidue[] = [],
): SnapshotResult {
  const served = result.systemSurface;
  return {
    ...result,
    comparisonIdentity: runnerComparisonIdentity(
      served ? surfaceLineage(deviceId, served.bundleId) : lineage,
      request,
      [...(served ? [] : residue), { kind: 'fallback-source', producer: 'apple-runner' }],
    ),
    warnings: [...(result.warnings ?? []), fallbackWarning(reason, lineage, served !== undefined)],
  };
}

/** The app generation the route planned this capture against. */
function appLineage(deviceId: string, input: CaptureSnapshotInput): IosSnapshotLineage {
  return { targetId: `${deviceId}:${input.options!.appBundleId!}` };
}

/** A served system surface, which is identified by the surface host and by no app generation. */
function surfaceLineage(deviceId: string, bundleId: string): IosSnapshotLineage {
  return { targetId: `${deviceId}:${bundleId}` };
}

function runnerComparisonIdentity(
  lineage: IosSnapshotLineage,
  request: ReturnType<typeof createIosSnapshotRequest>,
  residue: readonly IosAcquisitionResidue[],
): IosSnapshotComparisonIdentity {
  return Object.freeze({
    producer: 'apple-runner',
    intent: request.acquisitionIntent,
    lineage: Object.freeze({
      ...(lineage.targetId ? { targetId: lineage.targetId } : {}),
      ...(lineage.generation ? { generation: lineage.generation } : {}),
    }),
    presentationKey: buildIosSnapshotPresentationKey(request),
    residue: Object.freeze([...residue]),
  });
}

/**
 * A presented system surface is not a bridge failure: the bridge is healthy and simply cannot see
 * the surface, so it is inapplicable here rather than unavailable — and the capture belongs to that
 * surface, not to an app generation. A lingering host is the same decision over a surface the runner
 * did not serve, so that sentence says what the capture holds instead. Every other reason keeps the
 * unavailable sentence, in the scope the reason itself carries.
 */
function fallbackWarning(
  reason: FallbackReason,
  lineage: IosSnapshotLineage,
  served: boolean,
): string {
  if (reason === SYSTEM_SURFACE_PRESENTED) {
    return `Simulator AX snapshot inapplicable (${reason}); used XCTest to read the system surface presented over the app.`;
  }
  if (reason === SYSTEM_SURFACE_HOST_LINGERING) {
    return `Simulator AX snapshot inapplicable (${reason}); used XCTest, which read app content: the system surface host process was still running but no longer presenting.`;
  }
  const code = typeof reason === 'string' ? reason : reason.code;
  // The bridge was skipped for its own reason and the runner then found a surface over the app. The
  // app-generation sentence would describe a capture this is not, so the reason keeps its wording
  // and the content sentence says what arrived.
  if (served) {
    return `Simulator AX snapshot unavailable (${code}); used XCTest, which read the system surface presented over the app.`;
  }
  if (typeof reason !== 'string' && reason.scope === 'capture') {
    return captureScopedFallbackWarning(code, reason.consequence);
  }
  if (typeof reason !== 'string' && reason.scope === 'runner-session')
    return `Simulator AX snapshot unavailable (${code}); used XCTest for this runner session.`;
  const generation = lineage.generation ? 'this app generation' : 'an unverified app generation';
  return `Simulator AX snapshot unavailable (${code}); used XCTest for ${generation}.`;
}

/**
 * The sentence for a refusal the route did not retire the generation over; the generation sentence
 * would claim a retirement that did not happen (#2491).
 */
function captureScopedFallbackWarning(code: string, consequence: CaptureScopedConsequence): string {
  const thisCapture = `Simulator AX snapshot unavailable (${code}); used XCTest for this capture`;
  switch (consequence) {
    case 'bridge-preparation':
      return `${thisCapture} while the bridge is still being prepared.`;
    case 'bridge-read-busy':
      return `${thisCapture} while an earlier bridge read was still running.`;
    case 'foreground-ownership':
      return `${thisCapture}, while another surface owned the foreground.`;
    case 'tree-changed':
      return `${thisCapture}, while the screen changed during the bridge read.`;
    case 'window-not-full-screen':
      return `${thisCapture}, while the app window did not fill the screen; the runner republishes a windowed capture in screen space.`;
    case 'coordinate-space-unresolved':
      return `${thisCapture}, which reports captured geometry in the app's own orientation space.`;
  }
}

type FallbackIdentity = Readonly<{
  lineage: IosSnapshotLineage;
  residue: readonly IosAcquisitionResidue[];
}>;

async function resolveFailureFallbackIdentity<Target extends SnapshotBridgeRouteTarget>(
  failure: SnapshotSourceFailure,
  target: Target,
  device: DeviceInfo,
  appBundleId: string,
  signal: AbortSignal,
  resolveTarget: SnapshotBridgeChannel<Target>['resolveTarget'],
): Promise<FallbackIdentity> {
  if (failure.kind !== 'stale-target') return { lineage: target, residue: [] };
  try {
    return {
      lineage: await resolveTarget(device, appBundleId, signal, 'refresh'),
      residue: [],
    };
  } catch (error) {
    signal.throwIfAborted();
    emitRouteDiagnostic('fallback-target-resolution-failed', device, undefined, error);
    return {
      lineage: { targetId: target.targetId },
      residue: [unknownGenerationResidue()],
    };
  }
}

/**
 * Only a fallback that resolved no target in this capture carries it. A bridge refusal, including
 * `system-surface-host-unverified`, arrives after the route resolved the target, so it keeps the
 * generation.
 */
function unknownGenerationResidue(): IosAcquisitionResidue {
  return { kind: 'unknown-generation', captureId: randomUUID() };
}

function requestFor(input: CaptureSnapshotInput) {
  return createIosSnapshotRequest({
    raw: input.options?.raw,
    interactiveOnly: input.options?.interactiveOnly,
    depth: input.options?.depth,
    scope: input.options?.scope,
    customActions: input.options?.customActions,
    acquisitionIntent: input.options?.acquisitionIntent,
  });
}

function rebaselineGeneration(
  target: SnapshotBridgeRouteTarget,
  latestGeneration: Map<string, string>,
  disabledGenerations: Set<string>,
): void {
  const previous = latestGeneration.get(target.targetId);
  if (previous && previous !== target.generation) {
    disabledGenerations.delete(`${target.targetId}:${previous}`);
  }
  latestGeneration.set(target.targetId, target.generation);
}

function generationKey(target: SnapshotBridgeRouteTarget): string {
  return `${target.targetId}:${target.generation}`;
}

function emitRouteDiagnostic(
  reason: string,
  device: Pick<DeviceInfo, 'id'>,
  generation?: string,
  error?: unknown,
  details?: Readonly<Record<string, unknown>>,
): void {
  emitDiagnostic({
    level: 'debug',
    phase: 'ios_snapshot_route_fallback',
    data: {
      reason,
      deviceId: device.id,
      ...(generation ? { generation } : {}),
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
      ...(details ? { details } : {}),
    },
  });
}
