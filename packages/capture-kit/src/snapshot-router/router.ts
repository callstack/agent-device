import { randomUUID } from 'node:crypto';
import type {
  CaptureSnapshotInput,
  SnapshotResult,
  SnapshotRuntimeAcquiredResult,
  SnapshotRuntimePresenter,
} from '@agent-device/contracts/snapshot-runtime';
import type {
  CaptureHint,
  IosAcquisitionResidue,
  IosSnapshotComparisonIdentity,
  IosSnapshotLineage,
} from '@agent-device/contracts/ios-snapshot';
import { IOS_SYSTEM_SURFACE_HOSTS } from '@agent-device/contracts/ios-system-surface';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  buildIosSnapshotPresentationKey,
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '../ios-snapshot-planning.ts';
import {
  SnapshotSourceError,
  type SnapshotSourceFailure,
  type SnapshotSourceOutcome,
  type SystemSurfaceForegroundProbe,
  type SystemSurfaceForegroundReading,
} from './source-channel.ts';
import {
  bridgeFailureDisposition,
  type BridgeFailureDisposition,
  type BridgeFallbackDisposition,
  type CaptureScopedConsequence,
} from './refusal-policy.ts';

/**
 * The snapshot source router (ADR 0038). An owner with two snapshot sources declares its first
 * source as a channel, and its second source as the fallback each capture passes in. The router
 * owns the rest: the plan, surface proof, the per-generation and per-runner-session circuits, the
 * one fallback, refusal scope, identity, and warnings. It imports no platform or provider code; a
 * layering rule in `scripts/layering` holds that.
 */

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

export type SnapshotRouter = Readonly<{
  capture(
    device: DeviceInfo,
    input: CaptureSnapshotInput,
    signal: AbortSignal,
    fallback: SnapshotFallback,
  ): Promise<SnapshotResult>;
  /**
   * Records `target` as the newest generation of its app — which clears the circuit an earlier
   * generation opened — and reports whether the channel is disabled for it. A capture and a
   * launch-observation probe both ask before they spend a bridge round trip, so one generation's
   * failure is paid once rather than once per caller (#2198, #2199).
   */
  isBridgeDisabled(target: SnapshotRouteTarget): boolean;
  shutdown(): Promise<void>;
}>;

/** The app generation a channel read is planned against. */
export type SnapshotRouteTarget = Readonly<{
  pid: number;
  generation: string;
  targetId: string;
}>;

/**
 * One way to reach the bridge reader on a device: the source that reads, and how the app generation
 * it reads is named. A local Simulator reaches it through a guest process the host starts; a
 * Simulator whose host cannot start one reaches it through the XCTest runner.
 */
export type SnapshotSourceChannel<Target extends SnapshotRouteTarget> = Readonly<{
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
  /** Whether the channel can read this device at all; a capture on another device goes off route. */
  servesDevice(device: DeviceInfo): boolean;
  /** The app's target, which the channel may answer from its cache. */
  resolveTarget(device: DeviceInfo, appBundleId: string, signal: AbortSignal): Promise<Target>;
  /**
   * Forced rediscovery: reads the app's target again and never answers from a cache. Stale-target
   * evidence says the read met a newer process, so the fallback after it always calls this.
   */
  refreshTarget(device: DeviceInfo, appBundleId: string, signal: AbortSignal): Promise<Target>;
  /**
   * Whether `resolveTarget` verifies a cached target's process identity before it returns it. When
   * it does not, the router calls `refreshTarget` before it trusts a disabled circuit; otherwise a
   * relaunched app would stay off the bridge for good.
   */
  resolutionVerifiesIdentity: boolean;
  /**
   * Whether a resolution failure only says a detached discovery is still running and no other
   * source answers at once. The capture then resolves again, which joins that discovery.
   */
  awaitsDiscovery?(
    error: unknown,
    device: DeviceInfo,
    execution: Readonly<{ requestId?: string }>,
  ): Promise<boolean>;
  /** Whether an observe-only capture may use this source; when not, it goes to the direct fallback. */
  observeOnlySupported: boolean;
  /**
   * Declared by a channel whose surface proof names the runner session it read through. A new
   * session id swaps the circuit, and the router calls this so the channel drops its own state.
   */
  sessionChanged?(): void;
}>;

export function createSnapshotRouter<Target extends SnapshotRouteTarget>(
  /** The platform host's presenter, the only host behavior the router reads. */
  present: SnapshotRuntimePresenter,
  channel: SnapshotSourceChannel<Target>,
  surfaceForeground: SystemSurfaceForegroundProbe,
): SnapshotRouter {
  const { source } = channel;
  const freshCircuit = (sessionId?: string) => ({
    sessionId,
    disabledGenerations: new Set<string>(),
    latestGeneration: new Map<string, string>(),
    sessionDisabled: false,
  });
  let currentCircuit = freshCircuit();
  const isDisabledIn = (circuit: typeof currentCircuit, target: SnapshotRouteTarget) => {
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

  return Object.freeze({
    isBridgeDisabled: (target: SnapshotRouteTarget): boolean =>
      isDisabledIn(currentCircuit, target),
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
      const captureBridgeDisabled = (target: SnapshotRouteTarget) => isDisabledIn(circuit, target);
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
        target = await resolveCaptureTarget(channel, device, input, signal, captureBridgeDisabled);
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
          channel,
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
          async () => await present(outcome as SnapshotRuntimeAcquiredResult, input.options),
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
  });
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
 * A discovery still in flight is not a failure while no other source can answer instead: the
 * capture stays on the single-flight discovery, each turn waits one discovery slice, and the
 * discovery's own deadline or the request signal ends the loop (#2198, #2331). The channel decides
 * whether a failure is such a wait.
 */
async function resolveTargetForObservation<Target extends SnapshotRouteTarget>(
  channel: SnapshotSourceChannel<Target>,
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  signal: AbortSignal,
): Promise<Target> {
  const appBundleId = input.options!.appBundleId!;
  for (;;) {
    try {
      return await channel.resolveTarget(device, appBundleId, signal);
    } catch (error) {
      const execution = { requestId: input.execution?.requestId };
      if (!(await channel.awaitsDiscovery?.(error, device, execution))) throw error;
    }
  }
}

/**
 * The target this capture is planned against. While a generation's circuit is open no read meets a
 * newer process, so a channel whose resolution does not verify a cached target refreshes it before
 * the circuit is trusted. The fresh target rebaselines the circuit. A refresh that fails is a
 * resolution failure: the capture names no generation.
 */
async function resolveCaptureTarget<Target extends SnapshotRouteTarget>(
  channel: SnapshotSourceChannel<Target>,
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  signal: AbortSignal,
  isBridgeDisabled: (target: SnapshotRouteTarget) => boolean,
): Promise<Target> {
  const target = await resolveTargetForObservation(channel, device, input, signal);
  if (channel.resolutionVerifiesIdentity || !isBridgeDisabled(target)) return target;
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

function routeEligibility<Target extends SnapshotRouteTarget>(
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  channel: SnapshotSourceChannel<Target>,
): 'bridge' | 'direct' | 'off-route' {
  if (input.options?.observeOnly && !channel.observeOnlySupported) return 'direct';
  return channel.servesDevice(device) &&
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
  target: SnapshotRouteTarget,
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
  failedTarget: SnapshotRouteTarget,
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
  /** An observe-only capture on a source that cannot serve one: the runner result is returned as is. */
  | Readonly<{ kind: 'direct' }>
  /**
   * A capture the route has no bridge plan for (for example, a pinned backend or a custom-actions
   * read). The runner serves a presented system surface on this path too, so a surface capture still
   * gets a surface identity: without it, legacy presentation matching reads the sheet and the app as
   * one presentation and can corroborate a tap across the two (#2438). An app capture off the route
   * carries no identity.
   */
  | Readonly<{ kind: 'off-route' }>
  /**
   * A capture taken while the probe saw a surface host. The probe answers about a host process and
   * stays positive while a dismissed host lingers, but the runner answers about the screen, so this
   * plan decides only the reason, from what the runner served. The identity comes from the shared
   * stamp: an app capture in the lingering window must not compare equal to the sheet capture before
   * the dismissal (#2438). `detectedHost` is evidence for the daemon log, not identity.
   */
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

/**
 * The identity a fallback after a failed read publishes. A stale-target failure says the read met
 * a newer process, so the capture forces the channel's rediscovery before it names a generation.
 */
async function resolveFailureFallbackIdentity<Target extends SnapshotRouteTarget>(
  failure: SnapshotSourceFailure,
  target: Target,
  device: DeviceInfo,
  appBundleId: string,
  signal: AbortSignal,
  channel: SnapshotSourceChannel<Target>,
): Promise<FallbackIdentity> {
  if (failure.kind !== 'stale-target') return { lineage: target, residue: [] };
  try {
    return {
      lineage: await channel.refreshTarget(device, appBundleId, signal),
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
  target: SnapshotRouteTarget,
  latestGeneration: Map<string, string>,
  disabledGenerations: Set<string>,
): void {
  const previous = latestGeneration.get(target.targetId);
  if (previous && previous !== target.generation) {
    disabledGenerations.delete(`${target.targetId}:${previous}`);
  }
  latestGeneration.set(target.targetId, target.generation);
}

function generationKey(target: SnapshotRouteTarget): string {
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
