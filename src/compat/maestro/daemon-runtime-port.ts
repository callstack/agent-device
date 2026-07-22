import { AppError, asAppError } from '../../kernel/errors.ts';
import type { Rect } from '../../kernel/snapshot.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { stripUndefined } from '../../utils/parsing.ts';
import { executeRunScriptFile } from './run-script-execution.ts';
import {
  MAESTRO_COMPATIBILITY_PRESETS,
  MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
} from './compatibility-policy.ts';
import { maestroTestFailure } from './compatibility-errors.ts';
import {
  executeMaestroRuntimeCommand,
  maestroCommandRequiresSettledPredecessor,
} from './runtime-port-commands.ts';
import { operationContext } from './runtime-port-context.ts';
import { observeMaestroCondition } from './runtime-port-observation.ts';
import { waitForMaestroAnimationToEnd } from './wait-for-animation-to-end.ts';
import {
  withMaestroScreenshotBaseline,
  type MaestroScreenshotBaseline,
} from './maestro-screenshot-comparison.ts';
import type {
  MaestroRuntimeMetrics,
  MaestroRuntimePort,
  MaestroRuntimeRequest,
  MaestroRuntimeResult,
} from './engine-types.ts';
import type {
  MaestroDispatchSelector,
  MaestroRuntimeOperationContext,
  MaestroRuntimeReadContext,
  MaestroRuntimeOperations,
  MaestroTargetMatch,
  MaestroTargetQuery,
} from './runtime-port-types.ts';
import { pointInsideRect } from '../../utils/rect-center.ts';
import { resolveMaestroScrollableGesture } from './runtime-port-geometry.ts';
import {
  MAESTRO_OBSERVATION_POLL_MS,
  captureRetriableMaestroSnapshot,
  observeTypedMaestroCondition,
  resolveTypedMaestroTarget,
  scrollUntilTypedMaestroTarget,
  sleepWithinDeadline,
  waitForTypedSnapshotStability,
  maestroSnapshotSignature,
  type MaestroSnapshotSource,
} from './daemon-runtime-port-observation.ts';
import { createDaemonMaestroSnapshotSource } from './daemon-runtime-port-snapshot-source.ts';
import {
  artifactPathsFromData,
  invokeMaestroPublicOperation,
  launchArgumentValues,
  observationFromMatch,
  resolveScriptPath,
  stringifyEnvironment,
  type CreateDaemonMaestroRuntimeOperationsOptions,
} from './daemon-runtime-port-support.ts';
import type {
  MaestroClickOptions,
  MaestroPublicOperation,
} from './daemon-runtime-public-operation.ts';

export type { CreateDaemonMaestroRuntimeOperationsOptions } from './daemon-runtime-port-support.ts';

function createDaemonMaestroRuntimeParts(options: CreateDaemonMaestroRuntimeOperationsOptions): {
  operations: MaestroRuntimeOperations;
  snapshots: MaestroSnapshotSource;
  readMetrics: () => MaestroRuntimeMetrics;
} {
  const snapshots = createDaemonMaestroSnapshotSource(options);
  const metrics = { screenshotCaptures: 0, tapRetries: 0 };
  const platform = options.platform;
  const invoke = (operation: MaestroPublicOperation) => {
    if (operation.kind === 'screenshot') metrics.screenshotCaptures += 1;
    return invokeMaestroPublicOperation(options, operation);
  };
  const withMutation = async <T>(
    mutation: () => Promise<T>,
    context: MaestroRuntimeOperationContext,
    stability: 'none' | 'deferred' = 'none',
  ): Promise<T> => {
    snapshots.invalidate(context.generation);
    try {
      return await mutation();
    } finally {
      if (stability === 'deferred') snapshots.requireStability(context.generation);
    }
  };
  const invokeMutation = async (
    operation: MaestroPublicOperation,
    context: MaestroRuntimeOperationContext,
    stability: 'none' | 'deferred' = 'none',
  ) => await withMutation(() => invoke(operation), context, stability);
  const typeTextAndSettle = async (
    text: string,
    context: MaestroRuntimeOperationContext,
  ): Promise<void> => {
    await invokeMutation({ kind: 'typeText', text }, context);
    const stable = await waitForTypedSnapshotStability({
      timeoutMs: MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
      context,
      snapshot: snapshots.capture,
      dependencies: options.dependencies,
    });
    snapshots.prime(context.generation, stable.snapshot);
  };

  const operations: MaestroRuntimeOperations = {
    platform,
    resolveTarget: async (input, context) =>
      await resolveDaemonMaestroTarget({ input, context, snapshots, options }),
    observe: async (input, context) =>
      await observeTypedMaestroCondition({
        condition: input.condition,
        timeoutMs: input.timeoutMs,
        context,
        snapshot: snapshots.capture,
        dependencies: options.dependencies,
        platform,
      }),
    resolveGestureViewport: async (context) => {
      const viewport = await options.dependencies.resolveGestureViewport(context);
      if (!viewport) {
        throw new AppError('COMMAND_FAILED', 'Unable to resolve Maestro gesture viewport.');
      }
      return viewport;
    },

    launchApp: async (input, context) => {
      const appId = input.appId ?? context.appId;
      const launchArgs = [
        ...launchArgumentValues(input.arguments),
        ...launchArgumentValues(input.launchArguments),
      ];
      const clearState = input.clearState === true;
      const relaunch = !clearState && input.stopApp !== false;
      await invokeMutation(
        {
          kind: 'launchApp',
          ...(appId ? { appId } : {}),
          relaunch,
          clearState,
          launchArgs,
        },
        context,
        'deferred',
      );
    },
    stopApp: async (input, context) => {
      const appId = input.appId ?? context.appId;
      await invokeMutation({ kind: 'stopApp', ...(appId ? { appId } : {}) }, context);
    },
    openLink: async (input, context) => {
      await invokeMutation(
        {
          kind: 'openLink',
          ...(context.appId ? { appId: context.appId } : {}),
          link: input.link,
          prewarmRunner: platform === 'ios',
        },
        context,
        'deferred',
      );
    },

    tapOn: async (input, context) =>
      await tapTargetAndSettle(options, snapshots, metrics, input.target, context, {
        click: {
          count: input.repeat,
          intervalMs: input.delay,
        },
        retryIfNoChange: input.retryTapIfNoChange === true,
      }),
    doubleTapOn: async (input, context) => {
      await withMutation(
        () =>
          clickTarget(
            options,
            input.target.point,
            stripUndefined({
              doubleTap: true,
              intervalMs: input.delay,
            }),
          ),
        context,
        'deferred',
      );
    },
    longPressOn: async (input, context) => {
      await withMutation(
        () =>
          clickTarget(options, input.target.point, {
            holdMs: MAESTRO_COMPATIBILITY_PRESETS.command.longPressDurationMs,
          }),
        context,
        'deferred',
      );
    },
    gesture: async (input, context) => {
      const data = await invokeMutation(
        {
          kind: 'swipe',
          gesture: input,
          ...(context.gestureViewport ? { viewport: context.gestureViewport } : {}),
        },
        context,
        'deferred',
      );
      return data ? { data } : undefined;
    },
    inputText: async (input, context) => await typeTextAndSettle(input.text, context),
    eraseText: async (input, context) =>
      await typeTextAndSettle(
        '\b'.repeat(
          input.charactersToErase ?? MAESTRO_COMPATIBILITY_PRESETS.command.eraseTextMaxCharacters,
        ),
        context,
      ),
    scroll: async (input, context) => {
      await invokeMutation({ kind: 'scroll', direction: input.direction }, context, 'deferred');
    },
    scrollUntilVisible: async (input, context) => {
      const match = await scrollUntilTypedMaestroTarget({
        selector: input.selector,
        direction: input.direction,
        timeoutMs: input.timeoutMs,
        context,
        snapshot: snapshots.capture,
        dependencies: options.dependencies,
        platform,
        scroll: async (remainingMs, snapshot) => {
          const gesture = resolveMaestroScrollableGesture(
            snapshot,
            input.selector,
            input.direction,
            input.durationMs,
            platform,
          );
          await invokeMutation(
            gesture
              ? { kind: 'swipe', ...gesture }
              : {
                  kind: 'scroll',
                  direction: input.direction,
                  durationMs: input.durationMs,
                },
            context,
          );
          return (
            await waitForTypedSnapshotStability({
              timeoutMs: Math.min(MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS, remainingMs),
              context,
              snapshot: snapshots.capture,
              dependencies: options.dependencies,
            })
          ).snapshot;
        },
      });
      if (
        match.visiblePercentage !==
        MAESTRO_COMPATIBILITY_PRESETS.command.scrollUntilVisiblePercentage
      ) {
        throw maestroTestFailure('Maestro scrollUntilVisible target did not become visible.', {
          selector: input.selector,
          timeoutMs: input.timeoutMs,
        });
      }
      return {
        observation: snapshots.bindObservation(observationFromMatch(input.selector, match)),
      };
    },
    pressKey: async (input, context) => {
      await invokeMutation({ kind: 'pressKey', key: input.key }, context, 'deferred');
    },
    back: async (_input, context) => {
      await invokeMutation({ kind: 'pressKey', key: 'back' }, context, 'deferred');
    },
    hideKeyboard: async (_input, context) => {
      await invokeMutation({ kind: 'pressKey', key: 'dismiss' }, context, 'deferred');
    },
    waitForAnimationToEnd: async (input, context) => {
      const visualStabilityReached = await waitForMaestroAnimationToEnd({
        timeoutMs:
          input.timeoutMs ?? MAESTRO_COMPATIBILITY_PRESETS.command.waitForAnimationToEndTimeoutMs,
        now: options.dependencies.now,
        signal: context.signal,
        capture: async (screenshotPath) => {
          await invoke({
            kind: 'screenshot',
            path: screenshotPath,
            stabilize: false,
            ...(options.platform === 'ios' ? { captureBackend: 'runner' as const } : {}),
          });
        },
      });
      return { visualStabilityReached };
    },
    takeScreenshot: async (input) => ({
      artifactPaths: artifactPathsFromData(await invoke({ kind: 'screenshot', path: input.path })),
    }),
    runScript: async (input, context) => ({
      outputEnv: executeRunScriptFile({
        scriptPath: resolveScriptPath(input.file, context, options.sourcePath),
        env: {
          ...context.env,
          ...(input.env ? stringifyEnvironment(input.env) : {}),
        },
      }),
    }),
  };
  return {
    operations,
    snapshots,
    readMetrics: () => ({ ...snapshots.readMetrics(), ...metrics }),
  };
}

async function resolveDaemonMaestroTarget(params: {
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

function isActionableTarget(
  match: MaestroTargetMatch,
): match is MaestroTargetMatch & { rect: Rect } {
  return match.matched && match.visible && match.rect !== undefined;
}

function canUseResolvedTarget(match: MaestroTargetMatch, reusedObservation: boolean): boolean {
  if (!isActionableTarget(match)) return false;
  return !reusedObservation || match.dispatchSelector !== undefined;
}

export function createDaemonMaestroRuntimePort(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
): MaestroRuntimePort {
  const { operations, snapshots, readMetrics } = createDaemonMaestroRuntimeParts(options);
  return {
    execute: async (request: MaestroRuntimeRequest): Promise<MaestroRuntimeResult> => {
      const context = operationContext(request, request.command);
      const visualStabilityBarrier = request.command.kind === 'waitForAnimationToEnd';
      if (maestroCommandRequiresSettledPredecessor(request.command) && !visualStabilityBarrier) {
        await snapshots.settlePending(context);
      }
      const result = await executeMaestroRuntimeCommand(request, operations);
      if (visualStabilityBarrier && result.visualStabilityReached === true) {
        snapshots.consumeStabilityFromVisualWait(context);
      }
      delete result.visualStabilityReached;
      return result;
    },
    observe: async (request) => {
      const observation = await observeMaestroCondition(request, operations);
      return snapshots.bindObservation(observation);
    },
    readMetrics,
  };
}

async function tapTargetAndSettle(
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
    // Maestro retry parity requires pre-tap pixels; runtime metrics expose this unavoidable capture.
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
  const baselineSignature = await resolveTapBaselineSignature(
    target,
    snapshots,
    context,
    screenshotBaseline,
  );
  const settle = async () =>
    await waitForTypedSnapshotStability({
      timeoutMs: MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
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

async function resolveTapBaselineSignature(
  target: Parameters<MaestroRuntimeOperations['tapOn']>[0]['target'],
  snapshots: MaestroSnapshotSource,
  context: MaestroRuntimeOperationContext,
  screenshotBaseline: MaestroScreenshotBaseline | undefined,
): Promise<string | undefined> {
  if (target.resolution?.surfaceSignature) return target.resolution.surfaceSignature;
  if (screenshotBaseline) return undefined;
  return maestroSnapshotSignature(await snapshots.capture(context));
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
    attempts < MAESTRO_COMPATIBILITY_PRESETS.command.retryTapMaxAttempts
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
      await clickTarget(options, pointInsideRect(refreshed.rect), flags);
      return;
    }
  }
  snapshots.invalidate(context.generation);
  await clickTarget(options, target.point, flags);
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

async function clickTarget(
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
