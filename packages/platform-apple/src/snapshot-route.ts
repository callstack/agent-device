import { randomUUID } from 'node:crypto';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type {
  CaptureSnapshotInput,
  SnapshotResult,
  SnapshotRuntimeAcquiredResult,
} from '@agent-device/contracts/snapshot-runtime';
import type {
  IosAcquisitionResidue,
  IosSnapshotComparisonIdentity,
  IosSnapshotLineage,
} from '@agent-device/contracts/ios-snapshot';
import {
  buildIosSnapshotPresentationKey,
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  createSimulatorSnapshotSource,
  type SimulatorSnapshotSource,
  type SnapshotSourceOutcome,
  type SnapshotSourceFailure,
} from './snapshot-source-facade.ts';
import {
  createLaunchObservationProbe,
  type LaunchObservationPort,
} from './snapshot-observability.ts';
import {
  createSimulatorSnapshotTargetResolver,
  isSimulatorTargetDiscoveryPending,
  type SimulatorSnapshotTarget,
  type SimulatorSnapshotTargetResolver,
} from './snapshot-target.ts';
import {
  createSystemSurfacePresenceProbe,
  type SystemSurfacePresenceProbe,
} from './system-surface-presence.ts';

type SnapshotFallback = (input: CaptureSnapshotInput) => Promise<SnapshotResult>;

/** Why this capture left the bridge: a system surface the bridge cannot see was on screen. */
const SYSTEM_SURFACE_PRESENTED = 'system-surface-presented';

/**
 * The same decision, against the host-side probe's one documented false positive: the surface host
 * process outlives the dismissal of its sheet (see `system-surface-presence.ts`), so the bridge was
 * skipped for a surface the runner then did not serve.
 */
const SYSTEM_SURFACE_HOST_LINGERING = 'system-surface-host-lingering';

/**
 * Why this capture left the bridge: the bridge binary is still being built. The generation stays on
 * the bridge path, so the warning has to say the runner served this capture rather than the
 * generation (#2491).
 */
const BRIDGE_PREPARATION_PENDING = 'bridge-preparation-pending';

/**
 * Why this capture left the bridge: a window on this screen reports its subtree in the device's
 * native space and the reader cannot name the app's interface orientation to turn it back (#2612).
 * Like a bridge that is still being built, this says nothing about the app generation, which stays on
 * the bridge path and uses it again once the surface is gone.
 */
const WINDOW_COORDINATE_SPACE_UNRESOLVED = 'window-coordinate-space-unresolved';

export type AppleSnapshotRoute = LaunchObservationPort &
  Readonly<{
    capture(
      device: DeviceInfo,
      input: CaptureSnapshotInput,
      signal: AbortSignal,
      fallback: SnapshotFallback,
    ): Promise<SnapshotResult>;
    shutdown(): Promise<void>;
  }>;

export function createAppleSnapshotRoute(
  host: PlatformRuntimeHost,
  options: Readonly<{
    source?: SimulatorSnapshotSource;
    resolveTarget?: SimulatorSnapshotTargetResolver;
    systemSurfacePresent?: SystemSurfacePresenceProbe;
  }> = {},
): AppleSnapshotRoute {
  const source = options.source ?? createSimulatorSnapshotSource();
  const resolveTarget = options.resolveTarget ?? createSimulatorSnapshotTargetResolver();
  const systemSurfacePresent = options.systemSurfacePresent ?? createSystemSurfacePresenceProbe();
  const disabledGenerations = new Set<string>();
  const latestGeneration = new Map<string, string>();
  /**
   * Records `target` as the newest generation of its app — which clears the circuit an earlier
   * generation opened — and reports whether the bridge is disabled for it. Both a capture and the
   * launch-observation probe ask before they spend a bridge round trip, so one generation's
   * failure is paid once rather than once per route (#2198, #2199).
   */
  const isBridgeDisabled = (target: SimulatorSnapshotTarget): boolean => {
    rebaselineGeneration(target, latestGeneration, disabledGenerations);
    return disabledGenerations.has(generationKey(target));
  };
  const observation = createLaunchObservationProbe({
    source,
    resolveTarget,
    clock: host.clock,
    isBridgeDisabled,
  });

  return Object.freeze({
    awaitObservable: observation.awaitObservable,
    shutdown: async () => await source.close(),
    capture: async (device, input, signal, fallback) => {
      if (!isEligible(device, input)) return await captureOffRoute(device, input, fallback);
      const surfaceResult = await routeSystemSurface(
        systemSurfacePresent,
        device,
        input,
        signal,
        fallback,
      );
      if (surfaceResult) return surfaceResult;

      const resolution = await resolveTargetOrFallback(
        host,
        resolveTarget,
        device,
        input,
        signal,
        fallback,
      );
      if ('result' in resolution) return resolution.result;
      const { target } = resolution;
      if (isBridgeDisabled(target)) {
        return await captureWithDisabledBridge(device, target, input, fallback);
      }

      const request = requestFor(input);
      const outcome = await source.acquire({
        target,
        hint: deriveIosCaptureHint(request),
        signal,
      });
      if (outcome.stage === 'failed') {
        return await captureAfterSourceFailure({
          host,
          resolveTarget,
          disabledGenerations,
          device,
          input,
          signal,
          fallback,
          target,
          request,
          failure: outcome.failure,
        });
      }
      return await presentSourceAcquisition(
        host,
        disabledGenerations,
        device,
        input,
        fallback,
        target,
        request,
        outcome,
      );
    },
  });
}

function watchSnapshotBridgeFailure(
  device: DeviceInfo,
  bridgeFailureCode: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'watchOS Simulator accessibility bridge failed; no XCTest fallback is available.',
    {
      ...(details ?? {}),
      reason: 'watchos-ax-bridge-failed',
      deviceId: device.id,
      bridgeFailureCode,
    },
    cause,
  );
}

type CaptureTargetResolution =
  | Readonly<{ target: SimulatorSnapshotTarget }>
  | Readonly<{ result: SnapshotResult }>;

async function routeSystemSurface(
  systemSurfacePresent: SystemSurfacePresenceProbe,
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  signal: AbortSignal,
  fallback: SnapshotFallback,
): Promise<SnapshotResult | undefined> {
  // The watch bridge observes its own Simulator surface; the iOS host probe is not applicable.
  const presence =
    device.appleOs === 'watchos' ? ('absent' as const) : await systemSurfacePresent(device, signal);
  if (presence === 'unknown') {
    return await runFallback(
      device.id,
      input,
      fallback,
      appLineage(device.id, input),
      requestFor(input),
      'system-surface-probe-unavailable',
      [unknownGenerationResidue()],
    );
  }
  if (presence !== 'absent') {
    return await runSurfaceFallback(device, input, fallback, presence.host.bundleId);
  }
  return undefined;
}

async function resolveTargetOrFallback(
  host: PlatformRuntimeHost,
  resolveTarget: SimulatorSnapshotTargetResolver,
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  signal: AbortSignal,
  fallback: SnapshotFallback,
): Promise<CaptureTargetResolution> {
  try {
    return {
      target: await resolveTargetForObservation(host, resolveTarget, device, input, signal),
    };
  } catch (error) {
    rethrowIfResolutionCancelled(signal, error);
    emitRouteDiagnostic('target-resolution-failed', device, undefined, error);
    if (device.appleOs === 'watchos') {
      throw watchSnapshotBridgeFailure(device, 'target-resolution-failed', undefined, error);
    }
    return {
      result: await runFallback(
        device.id,
        input,
        fallback,
        appLineage(device.id, input),
        requestFor(input),
        'target-resolution-failed',
        [unknownGenerationResidue()],
      ),
    };
  }
}

async function captureWithDisabledBridge(
  device: DeviceInfo,
  target: SimulatorSnapshotTarget,
  input: CaptureSnapshotInput,
  fallback: SnapshotFallback,
): Promise<SnapshotResult> {
  emitRouteDiagnostic('circuit-disabled', device, target.generation);
  if (device.appleOs === 'watchos') throw watchSnapshotBridgeFailure(device, 'circuit-disabled');
  return await runFallback(
    device.id,
    input,
    fallback,
    target,
    requestFor(input),
    'circuit-disabled',
  );
}

async function captureAfterSourceFailure(
  options: Readonly<{
    host: PlatformRuntimeHost;
    resolveTarget: SimulatorSnapshotTargetResolver;
    disabledGenerations: Set<string>;
    device: DeviceInfo;
    input: CaptureSnapshotInput;
    signal: AbortSignal;
    fallback: SnapshotFallback;
    target: SimulatorSnapshotTarget;
    request: ReturnType<typeof createIosSnapshotRequest>;
    failure: SnapshotSourceFailure;
  }>,
): Promise<SnapshotResult> {
  const { failure, signal, device, target, input, fallback, request, disabledGenerations } =
    options;
  if (failure.kind === 'cancelled') {
    signal.throwIfAborted();
    throw new AppError('COMMAND_FAILED', 'Simulator AX snapshot acquisition was cancelled.', {
      reason: failure.code,
      ...failure.details,
    });
  }
  if (device.appleOs === 'watchos') throw watchAcquisitionFailure(device, failure);
  const identity = await resolveFailureFallbackIdentity(
    failure,
    target,
    device,
    input.options!.appBundleId!,
    signal,
    options.resolveTarget,
  );
  return await fallbackAfterFailure(
    input,
    fallback,
    target,
    identity,
    request,
    failure,
    disabledGenerations,
  );
}

function watchAcquisitionFailure(device: DeviceInfo, failure: SnapshotSourceFailure): AppError {
  if (failure.kind !== 'preparing') {
    return watchSnapshotBridgeFailure(device, failure.code, failure.details);
  }
  emitRouteDiagnostic(failure.code, device, undefined, undefined, failure.details);
  return new AppError(
    'COMMAND_FAILED',
    'watchOS Simulator accessibility bridge preparation is still running; retry the snapshot shortly.',
    {
      ...(failure.details ?? {}),
      reason: 'watchos-ax-bridge-preparing',
      deviceId: device.id,
      bridgeFailureCode: failure.code,
      retryable: true,
    },
  );
}

async function presentSourceAcquisition(
  host: PlatformRuntimeHost,
  disabledGenerations: Set<string>,
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  fallback: SnapshotFallback,
  target: SimulatorSnapshotTarget,
  request: ReturnType<typeof createIosSnapshotRequest>,
  outcome: SnapshotSourceOutcome,
): Promise<SnapshotResult> {
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
    if (device.appleOs === 'watchos') {
      throw watchSnapshotBridgeFailure(device, 'presentation-failed', undefined, error);
    }
    return await fallbackAfterFailure(
      input,
      fallback,
      target,
      { lineage: target, residue: [] },
      request,
      { kind: 'malformed-tree', code: 'presentation-invariant' },
      disabledGenerations,
      error,
    );
  }
}

/**
 * A discovery still in flight is not a failure while no runner can answer instead. The XCTest
 * fallback would first wait for a runner start, and #2198 keeps observation off that wait, so the
 * capture stays on the single-flight discovery: each turn waits one discovery slice, and the
 * discovery's own deadline or the request signal ends the loop. A runner that is already live
 * answers at once, so there the fallback remains the cheaper route (#2331).
 */
async function resolveTargetForObservation(
  host: PlatformRuntimeHost,
  resolveTarget: SimulatorSnapshotTargetResolver,
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  signal: AbortSignal,
): Promise<SimulatorSnapshotTarget> {
  const appBundleId = input.options!.appBundleId!;
  for (;;) {
    try {
      return await resolveTarget(device, appBundleId, signal);
    } catch (error) {
      if (!isSimulatorTargetDiscoveryPending(error)) throw error;
      const execution = { requestId: input.execution?.requestId };
      if (await host.appleApplications.hasLiveRunnerSession(device, execution)) throw error;
    }
  }
}

/**
 * A cancelled target resolution rethrows the resolver's own cancellation, which names the readiness
 * phase only when the resolver was waiting on a running discovery.
 */
function rethrowIfResolutionCancelled(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) throw isRequestCanceledError(error) ? error : signal.reason;
}

function isEligible(device: DeviceInfo, input: CaptureSnapshotInput): boolean {
  return (
    isAppleSimulator(device) &&
    supportsSimulatorSnapshot(device) &&
    hasAppTarget(input) &&
    usesDefaultCapture(input)
  );
}

function isAppleSimulator(device: DeviceInfo): boolean {
  return device.platform === 'apple' && device.kind === 'simulator';
}

function supportsSimulatorSnapshot(device: DeviceInfo): boolean {
  return device.appleOs === 'ios' || device.appleOs === 'watchos';
}

function hasAppTarget(input: CaptureSnapshotInput): boolean {
  return Boolean(input.options?.appBundleId);
}

function usesDefaultCapture(input: CaptureSnapshotInput): boolean {
  return input.options?.customActions !== true && input.options?.preferredBackend === undefined;
}

async function fallbackAfterFailure(
  input: CaptureSnapshotInput,
  fallback: SnapshotFallback,
  failedTarget: SimulatorSnapshotTarget,
  identity: FallbackIdentity,
  request: ReturnType<typeof createIosSnapshotRequest>,
  failure: SnapshotSourceFailure,
  disabledGenerations: Set<string>,
  cause?: unknown,
): Promise<SnapshotResult> {
  // A failed bridge is evidence about this app generation, so its captures take the runner until the
  // generation is rebaselined. Two failures are evidence about something else instead: a bridge that is
  // merely still being prepared speaks for the daemon's build queue, and a screen holding a surface in
  // another coordinate space speaks for this capture only. Both have to be able to use the bridge on
  // the next capture, which is what let one cold host cost every later capture of a stable screen
  // (#2491) and would otherwise cost every portrait capture after one landscape keyboard (#2612).
  if (opensGenerationCircuit(failure)) disabledGenerations.add(generationKey(failedTarget));
  emitRouteDiagnostic(
    failure.code,
    { id: failedTarget.simulator.udid },
    failedTarget.generation,
    cause,
    failure.details,
  );
  return await runFallback(
    failedTarget.simulator.udid,
    input,
    fallback,
    identity.lineage,
    request,
    failure.code,
    identity.residue,
  );
}

/**
 * Whether a bridge failure is evidence that this app generation cannot be served by the bridge.
 *
 * Two failures say something else instead. A bridge that is still being prepared speaks for the
 * daemon's build queue, and a screen holding a surface in another coordinate space speaks for this
 * capture only: the surface is on screen now and gone after the next keystroke, so retiring the
 * generation would move every later capture of a healthy app to the runner to work around one screen
 * (#2491 settled the first of these, and #2612 the second).
 */
function opensGenerationCircuit(failure: SnapshotSourceFailure): boolean {
  return failure.kind !== 'preparing' && failure.code !== WINDOW_COORDINATE_SPACE_UNRESOLVED;
}

async function runFallback(
  deviceId: string,
  input: CaptureSnapshotInput,
  fallback: SnapshotFallback,
  lineage: IosSnapshotLineage,
  request: ReturnType<typeof createIosSnapshotRequest>,
  reason: string,
  residue: readonly IosAcquisitionResidue[] = [],
): Promise<SnapshotResult> {
  return stampFallback(deviceId, await fallback(input), lineage, request, reason, residue);
}

/**
 * The `present` path's capture. The probe answers about a host PROCESS and stays positive while a
 * dismissed host lingers, while the runner answers about the screen — so only the reason is decided
 * here, from what the runner served. The identity comes from the shared stamping point, which reads
 * the same stamp: if the probe decided identity instead, an app capture taken in the lingering
 * window would be lineaged to the host and compare EQUAL to the sheet capture before the dismissal,
 * which is exactly the transition a post-gesture poll must not miss (#2438).
 *
 * `detectedHost` is therefore evidence, not identity: it names the host the probe matched so a
 * lingering window is legible in the daemon log instead of looking like a missing bridge capture.
 */
async function runSurfaceFallback(
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  fallback: SnapshotFallback,
  detectedHost: string,
): Promise<SnapshotResult> {
  const result = await fallback(input);
  const reason = result.systemSurface ? SYSTEM_SURFACE_PRESENTED : SYSTEM_SURFACE_HOST_LINGERING;
  if (!result.systemSurface) {
    emitRouteDiagnostic(reason, device, undefined, undefined, { detectedHost });
  }
  return stampFallback(device.id, result, appLineage(device.id, input), requestFor(input), reason);
}

/**
 * A capture the route cannot plan — a pinned backend or a custom-actions read, see
 * {@link isEligible} — still reaches the XCTest runner, and the runner serves a presented system
 * surface on those paths too. Such a capture describes the surface rather than the app, so it is
 * identified like any other surface capture: without an identity it would fall back to legacy
 * presentation matching, where a sheet and the app read as the same presentation and could
 * corroborate a tap across the two (#2438). An app capture off the route carries no identity, as
 * before: the route planned nothing about it.
 */
async function captureOffRoute(
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  fallback: SnapshotFallback,
): Promise<SnapshotResult> {
  const result = await fallback(input);
  const served = result.systemSurface;
  if (!served) return result;
  return {
    ...result,
    comparisonIdentity: runnerComparisonIdentity(
      surfaceLineage(device.id, served.bundleId),
      requestFor(input),
      [],
    ),
  };
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
  reason: string,
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
 * unavailable sentence.
 */
function fallbackWarning(reason: string, lineage: IosSnapshotLineage, served: boolean): string {
  if (reason === SYSTEM_SURFACE_PRESENTED) {
    return `Simulator AX snapshot inapplicable (${reason}); used XCTest to read the system surface presented over the app.`;
  }
  if (reason === SYSTEM_SURFACE_HOST_LINGERING) {
    return `Simulator AX snapshot inapplicable (${reason}); used XCTest, which read app content: the system surface host process was still running but no longer presenting.`;
  }
  // The bridge was skipped for its own reason and the runner then found a surface over the app. The
  // app-generation sentence would describe a capture this is not, so the reason keeps its wording
  // and the content sentence says what arrived.
  if (served) {
    return `Simulator AX snapshot unavailable (${reason}); used XCTest, which read the system surface presented over the app.`;
  }
  // A bridge that is still being built says nothing about this generation, and the route keeps the
  // generation on the bridge path because of it. The generation sentence would claim a retirement
  // that did not happen (#2491).
  if (reason === BRIDGE_PREPARATION_PENDING) {
    return `Simulator AX snapshot unavailable (${reason}); used XCTest for this capture while the bridge is still being prepared.`;
  }
  if (reason === WINDOW_COORDINATE_SPACE_UNRESOLVED) {
    return `Simulator AX snapshot unavailable (${reason}); used XCTest for this capture, which reports captured geometry in the app's own orientation space.`;
  }
  const generation = lineage.generation ? 'this app generation' : 'an unverified app generation';
  return `Simulator AX snapshot unavailable (${reason}); used XCTest for ${generation}.`;
}

type FallbackIdentity = Readonly<{
  lineage: IosSnapshotLineage;
  residue: readonly IosAcquisitionResidue[];
}>;

async function resolveFailureFallbackIdentity(
  failure: SnapshotSourceFailure,
  target: SimulatorSnapshotTarget,
  device: DeviceInfo,
  appBundleId: string,
  signal: AbortSignal,
  resolveTarget: SimulatorSnapshotTargetResolver,
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
  target: SimulatorSnapshotTarget,
  latestGeneration: Map<string, string>,
  disabledGenerations: Set<string>,
): void {
  const previous = latestGeneration.get(target.targetId);
  if (previous && previous !== target.generation) {
    disabledGenerations.delete(`${target.targetId}:${previous}`);
  }
  latestGeneration.set(target.targetId, target.generation);
}

function generationKey(target: SimulatorSnapshotTarget): string {
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
