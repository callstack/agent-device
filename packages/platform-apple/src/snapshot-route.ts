import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type {
  CaptureSnapshotInput,
  SnapshotResult,
  SnapshotRuntimeAcquiredResult,
} from '@agent-device/contracts/snapshot-runtime';
import type {
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
import { resolveSimulatorSnapshotTarget, type SimulatorSnapshotTarget } from './snapshot-target.ts';

type SnapshotFallback = (input: CaptureSnapshotInput) => Promise<SnapshotResult>;

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
    resolveTarget?: typeof resolveSimulatorSnapshotTarget;
  }> = {},
): AppleSnapshotRoute {
  const source = options.source ?? createSimulatorSnapshotSource();
  const resolveTarget = options.resolveTarget ?? resolveSimulatorSnapshotTarget;
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
        emitRouteDiagnostic('target-resolution-failed', device, undefined, error);
        return await runFallback(
          input,
          fallback,
          { targetId: `${device.id}:${input.options!.appBundleId!}` },
          requestFor(input),
          'target-resolution-failed',
        );
      }
      rebaselineGeneration(target, latestGeneration, disabledGenerations);
      const circuitKey = generationKey(target);
      if (disabledGenerations.has(circuitKey)) {
        return await runFallback(input, fallback, target, requestFor(input), 'circuit-disabled');
      }

      const request = requestFor(input);
      const outcome = await source.acquire({
        target,
        hint: deriveIosCaptureHint(request),
        signal,
      });
      if (outcome.stage === 'failed') {
        if (outcome.failure.kind === 'cancelled') {
          signal.throwIfAborted();
          throw new AppError('COMMAND_FAILED', 'Simulator AX snapshot acquisition was cancelled.', {
            reason: outcome.failure.code,
            ...outcome.failure.details,
          });
        }
        return await fallbackAfterFailure(
          input,
          fallback,
          target,
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
  target: SimulatorSnapshotTarget,
  request: ReturnType<typeof createIosSnapshotRequest>,
  failure: SnapshotSourceFailure,
  disabledGenerations: Set<string>,
  cause?: unknown,
): Promise<SnapshotResult> {
  disabledGenerations.add(generationKey(target));
  emitRouteDiagnostic(failure.code, { id: target.udid }, target.generation, cause, failure.details);
  return await runFallback(input, fallback, target, request, failure.code);
}

async function runFallback(
  input: CaptureSnapshotInput,
  fallback: SnapshotFallback,
  lineage: IosSnapshotLineage,
  request: ReturnType<typeof createIosSnapshotRequest>,
  reason: string,
): Promise<SnapshotResult> {
  const result = await fallback(input);
  const comparisonIdentity: IosSnapshotComparisonIdentity = Object.freeze({
    producer: 'apple-runner',
    intent: request.acquisitionIntent,
    lineage: Object.freeze({ ...lineage }),
    presentationKey: buildIosSnapshotPresentationKey(request),
    residue: Object.freeze([{ kind: 'fallback-source', producer: 'apple-runner' } as const]),
  });
  const warning = `Simulator AX snapshot unavailable (${reason}); used XCTest for this app generation.`;
  return {
    ...result,
    comparisonIdentity,
    warnings: [...(result.warnings ?? []), warning],
  };
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
