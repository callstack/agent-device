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
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  createSimulatorSnapshotSource,
  type SimulatorSnapshotSource,
  type SnapshotSourceFailure,
} from './snapshot-source-facade.ts';
import {
  createSimulatorSnapshotTargetResolver,
  type SimulatorSnapshotTarget,
  type SimulatorSnapshotTargetResolver,
} from './snapshot-target.ts';

type SnapshotFallback = (input: CaptureSnapshotInput) => Promise<SnapshotResult>;

/**
 * A freshly launched app is not yet the primary foreground owner while SpringBoard animates it in,
 * and its accessibility server registers a moment after its process appears. The bridge reports
 * those states as typed failures. Falling back on them would start the XCTest runner for a snapshot
 * the bridge serves a moment later, so a young target is re-read for a bounded grace before the
 * typed fallback applies. The grace is measured from the first failure, because the bridge's own
 * cold start may already have consumed the launch, and it is short for ownership misses: a system
 * dialog produces the same code and must still reach the fallback quickly. An established target
 * gets no grace at all.
 */
const LAUNCH_YOUNG_TARGET_MS = 10_000;
const LAUNCH_GRACE_POLL_MS = 150;
const LAUNCH_GRACE_BY_CODE: ReadonlyMap<string, number> = new Map([
  ['application-element-missing', 5_000],
  ['application-server-unavailable', 5_000],
  ['foreground-owner-unverified', 1_000],
  ['foreground-owner-changed', 1_000],
]);

export type AppleSnapshotRoute = Readonly<{
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
  }> = {},
): AppleSnapshotRoute {
  const source = options.source ?? createSimulatorSnapshotSource();
  const resolveTarget = options.resolveTarget ?? createSimulatorSnapshotTargetResolver();
  const disabledGenerations = new Set<string>();
  const latestGeneration = new Map<string, string>();

  return Object.freeze({
    shutdown: async () => await source.close(),
    capture: async (device, input, signal, fallback) => {
      if (!isEligible(device, input)) return await fallback(input);
      let target: SimulatorSnapshotTarget;
      try {
        target = await resolveTarget(device, input.options!.appBundleId!, signal);
      } catch (error) {
        signal.throwIfAborted();
        emitRouteDiagnostic('target-resolution-failed', device, undefined, error);
        return await runFallback(
          input,
          fallback,
          { targetId: `${device.id}:${input.options!.appBundleId!}` },
          requestFor(input),
          'target-resolution-failed',
          [unknownGenerationResidue()],
        );
      }
      rebaselineGeneration(target, latestGeneration, disabledGenerations);
      const circuitKey = generationKey(target);
      if (disabledGenerations.has(circuitKey)) {
        return await runFallback(input, fallback, target, requestFor(input), 'circuit-disabled');
      }

      const request = requestFor(input);
      const acquire = async () =>
        await source.acquire({ target, hint: deriveIosCaptureHint(request), signal });
      let outcome = await acquire();
      if (outcome.stage === 'failed') {
        const graceMs = launchGraceFor(outcome.failure, target, host.clock.now());
        const deadline = host.clock.now() + graceMs;
        while (
          outcome.stage === 'failed' &&
          LAUNCH_GRACE_BY_CODE.has(outcome.failure.code) &&
          host.clock.now() < deadline
        ) {
          emitRouteDiagnostic('launch-grace-retry', device, target.generation, undefined, {
            code: outcome.failure.code,
          });
          await host.clock.sleep(LAUNCH_GRACE_POLL_MS, signal);
          outcome = await acquire();
        }
      }
      if (outcome.stage === 'failed') {
        if (outcome.failure.kind === 'cancelled') {
          signal.throwIfAborted();
          throw new AppError('COMMAND_FAILED', 'Simulator AX snapshot acquisition was cancelled.', {
            reason: outcome.failure.code,
            ...outcome.failure.details,
          });
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
          input,
          fallback,
          target,
          fallbackIdentity,
          request,
          outcome.failure,
          disabledGenerations,
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
    },
  });
}

function isEligible(device: DeviceInfo, input: CaptureSnapshotInput): boolean {
  return (
    device.platform === 'apple' &&
    device.appleOs === 'ios' &&
    device.kind === 'simulator' &&
    Boolean(input.options?.appBundleId) &&
    input.options?.customActions !== true &&
    input.options?.preferredBackend === undefined
  );
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
  disabledGenerations.add(generationKey(failedTarget));
  emitRouteDiagnostic(
    failure.code,
    { id: failedTarget.udid },
    failedTarget.generation,
    cause,
    failure.details,
  );
  return await runFallback(
    input,
    fallback,
    identity.lineage,
    request,
    failure.code,
    identity.residue,
  );
}

async function runFallback(
  input: CaptureSnapshotInput,
  fallback: SnapshotFallback,
  lineage: IosSnapshotLineage,
  request: ReturnType<typeof createIosSnapshotRequest>,
  reason: string,
  residue: readonly IosAcquisitionResidue[] = [],
): Promise<SnapshotResult> {
  const result = await fallback(input);
  const comparisonIdentity: IosSnapshotComparisonIdentity = Object.freeze({
    producer: 'apple-runner',
    intent: request.acquisitionIntent,
    lineage: Object.freeze({
      ...(lineage.targetId ? { targetId: lineage.targetId } : {}),
      ...(lineage.generation ? { generation: lineage.generation } : {}),
    }),
    presentationKey: buildIosSnapshotPresentationKey(request),
    residue: Object.freeze([
      ...residue,
      { kind: 'fallback-source', producer: 'apple-runner' } as const,
    ]),
  });
  const generation = lineage.generation ? 'this app generation' : 'an unverified app generation';
  const warning = `Simulator AX snapshot unavailable (${reason}); used XCTest for ${generation}.`;
  return {
    ...result,
    comparisonIdentity,
    warnings: [...(result.warnings ?? []), warning],
  };
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

function launchGraceFor(
  failure: SnapshotSourceFailure,
  target: SimulatorSnapshotTarget,
  nowMs: number,
): number {
  const graceMs = LAUNCH_GRACE_BY_CODE.get(failure.code);
  if (graceMs === undefined) return 0;
  // `ps -o lstart=` text; an unparseable start time counts as established, never as young.
  const startedAtMs = Date.parse(target.processStartTime);
  if (Number.isNaN(startedAtMs)) return 0;
  return Math.max(0, nowMs - startedAtMs) < LAUNCH_YOUNG_TARGET_MS ? graceMs : 0;
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
