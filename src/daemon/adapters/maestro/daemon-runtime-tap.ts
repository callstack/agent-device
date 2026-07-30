import { AppError, asAppError } from '@agent-device/kernel/errors';
import type { Rect } from '@agent-device/kernel/snapshot';
import {
  MAESTRO_RUNTIME_ADAPTER_POLICY,
  type MaestroDispatchSelector,
  type MaestroRuntimeOperationContext,
  type MaestroRuntimeOperations,
  type MaestroRuntimeReadContext,
  type MaestroTargetMatch,
  type MaestroTargetQuery,
} from '@agent-device/maestro';
import { emitDiagnostic } from '../../../utils/diagnostics.ts';
import { pointInsideRect } from '../../../utils/rect-center.ts';
import {
  withMaestroScreenshotBaseline,
  type MaestroScreenshotBaseline,
} from './maestro-screenshot-comparison.ts';
import {
  MAESTRO_OBSERVATION_POLL_MS,
  captureRetriableMaestroSnapshot,
  maestroSnapshotSignature,
  resolveTypedMaestroTarget,
  sleepWithinDeadline,
  waitForTypedSnapshotStability,
  type MaestroSnapshotSource,
} from './daemon-runtime-port-observation.ts';
import {
  invokeMaestroPublicOperation,
  type CreateDaemonMaestroRuntimeOperationsOptions,
} from './daemon-runtime-port-support.ts';
import type { MaestroClickOptions } from './daemon-runtime-public-operation.ts';

export async function resolveDaemonMaestroTarget(params: {
  input: MaestroTargetQuery & { timeoutMs: number };
  context: MaestroRuntimeReadContext;
  snapshots: MaestroSnapshotSource;
  options: CreateDaemonMaestroRuntimeOperationsOptions;
  allowObservationReuse?: boolean;
}): Promise<MaestroTargetMatch> {
  const { input, context, snapshots, options } = params;
  const deadline = options.dependencies.now() + input.timeoutMs;
  let currentSnapshot =
    params.allowObservationReuse === false ? undefined : snapshots.reuseObservation(context);
  while (true) {
    const captureStartedAt = options.dependencies.now();
    const reusedObservation = currentSnapshot !== undefined;
    currentSnapshot ??= await captureRetriableMaestroSnapshot(
      { context, snapshot: snapshots.capture, dependencies: options.dependencies },
      deadline,
    );
    const match = resolveTypedMaestroTarget({
      query: input,
      context,
      snapshot: currentSnapshot,
      platform: options.platform,
    });
    if (canUseResolvedTarget(match, reusedObservation)) return match;
    currentSnapshot = undefined;
    if (reusedObservation) continue;
    if (captureStartedAt >= deadline) return match;
    await sleepWithinDeadline(
      options.dependencies,
      deadline,
      MAESTRO_OBSERVATION_POLL_MS,
      context.signal,
    );
  }
}

export async function tapTargetAndSettle(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
  snapshots: MaestroSnapshotSource,
  metrics: { screenshotCaptures: number; tapRetries: number },
  target: Parameters<MaestroRuntimeOperations['tapOn']>[0]['target'],
  context: MaestroRuntimeOperationContext,
  policy: { click: MaestroClickOptions; retryIfNoChange: boolean },
): Promise<void> {
  const dispatch = async () =>
    await dispatchTapTarget(options, snapshots, target, context, policy.click);
  if (!policy.retryIfNoChange) {
    try {
      await dispatch();
    } finally {
      snapshots.requireStability(context.generation);
    }
    return;
  }

  if (options.platform === 'ios') {
    await withMaestroScreenshotBaseline({
      signal: context.signal,
      capture: async (path) => {
        metrics.screenshotCaptures += 1;
        await invokeMaestroPublicOperation(options, {
          kind: 'screenshot',
          path,
          stabilize: false,
          captureBackend: 'runner',
        });
      },
      run: async (baseline) =>
        await tapTargetWithRetry(
          options,
          snapshots,
          metrics,
          target,
          context,
          policy.click,
          baseline,
        ),
    });
    return;
  }

  await tapTargetWithRetry(options, snapshots, metrics, target, context, policy.click);
}

async function tapTargetWithRetry(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
  snapshots: MaestroSnapshotSource,
  metrics: { screenshotCaptures: number; tapRetries: number },
  target: Parameters<MaestroRuntimeOperations['tapOn']>[0]['target'],
  context: MaestroRuntimeOperationContext,
  flags: MaestroClickOptions,
  screenshotBaseline?: MaestroScreenshotBaseline,
): Promise<void> {
  const dispatch = async () => await dispatchTapTarget(options, snapshots, target, context, flags);
  const baselineSignature =
    target.resolution?.surfaceSignature ??
    (screenshotBaseline ? undefined : maestroSnapshotSignature(await snapshots.capture(context)));
  const settle = async () =>
    await waitForTypedSnapshotStability({
      timeoutMs: MAESTRO_RUNTIME_ADAPTER_POLICY.settleTimeoutMs,
      context,
      snapshot: snapshots.capture,
      dependencies: options.dependencies,
    });

  try {
    const observed = await executeTapRetryLoop({
      baselineSignature,
      screenshotBaseline,
      dispatch,
      settle,
      onRetry: () => {
        metrics.tapRetries += 1;
      },
    });
    snapshots.prime(context.generation, observed.snapshot);
  } catch (error) {
    snapshots.requireStability(context.generation);
    throw error;
  }
}

async function executeTapRetryLoop(params: {
  readonly baselineSignature?: string;
  readonly screenshotBaseline?: MaestroScreenshotBaseline;
  readonly dispatch: () => Promise<void>;
  readonly settle: () => ReturnType<typeof waitForTypedSnapshotStability>;
  readonly onRetry: () => void;
}) {
  await params.dispatch();
  let observed = await params.settle();
  let attempts = 1;
  while (
    (params.baselineSignature === undefined || observed.signature === params.baselineSignature) &&
    attempts < MAESTRO_RUNTIME_ADAPTER_POLICY.retryTapMaxAttempts
  ) {
    if (params.screenshotBaseline && (await params.screenshotBaseline.matchesCurrent()) !== true) {
      break;
    }
    params.onRetry();
    await params.dispatch();
    attempts += 1;
    observed = await params.settle();
  }
  return observed;
}

async function dispatchTapTarget(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
  snapshots: MaestroSnapshotSource,
  target: Parameters<MaestroRuntimeOperations['tapOn']>[0]['target'],
  context: MaestroRuntimeOperationContext,
  flags: MaestroClickOptions,
): Promise<void> {
  const resolution = target.resolution;
  const dispatchSelector = resolution?.dispatchSelector;
  if (dispatchSelector && target.point) {
    snapshots.invalidate(context.generation);
    try {
      await clickSelector(options, dispatchSelector, target.point, flags);
      return;
    } catch (error) {
      if (!isAtomicSelectorFallbackError(error)) throw error;
      const refreshed = await resolveDaemonMaestroTarget({
        input: resolution.query,
        context,
        snapshots,
        options,
        allowObservationReuse: false,
      });
      if (!isActionableTarget(refreshed)) throw error;
      snapshots.invalidate(context.generation);
      await clickMaestroTargetPoint(options, pointInsideRect(refreshed.rect), flags);
      return;
    }
  }
  snapshots.invalidate(context.generation);
  await clickMaestroTargetPoint(options, target.point, flags);
}

function isActionableTarget(
  match: MaestroTargetMatch,
): match is MaestroTargetMatch & { rect: Rect } {
  return match.matched && match.visible && match.rect !== undefined;
}

function canUseResolvedTarget(match: MaestroTargetMatch, reusedObservation: boolean): boolean {
  if (!isActionableTarget(match)) return false;
  return !reusedObservation || match.dispatchSelector !== undefined;
}

async function clickSelector(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
  selector: MaestroDispatchSelector,
  expectedPoint: { x: number; y: number },
  flags: MaestroClickOptions,
): Promise<void> {
  emitDiagnostic({
    level: 'debug',
    phase: 'maestro_tap_dispatch',
    data: { kind: 'selector', selectorKey: selector.key, expectedPoint },
  });
  await invokeMaestroPublicOperation(options, {
    kind: 'clickSelector',
    selector,
    expectedPoint,
    options: flags,
  });
}

function isAtomicSelectorFallbackError(error: unknown): boolean {
  const code = asAppError(error).code;
  return code === 'AMBIGUOUS_MATCH' || code === 'ELEMENT_NOT_FOUND' || code === 'ELEMENT_OFFSCREEN';
}

export async function clickMaestroTargetPoint(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
  point: { x: number; y: number } | undefined,
  flags: MaestroClickOptions,
): Promise<void> {
  if (!point) throw new AppError('COMMAND_FAILED', 'Maestro target did not resolve to a point.');
  emitDiagnostic({
    level: 'debug',
    phase: 'maestro_tap_dispatch',
    data: { kind: 'point', point },
  });
  await invokeMaestroPublicOperation(options, {
    kind: 'clickPoint',
    point,
    options: flags,
  });
}
