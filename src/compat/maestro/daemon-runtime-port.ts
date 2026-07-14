import { AppError, asAppError } from '../../kernel/errors.ts';
import type { Rect, SnapshotState } from '../../kernel/snapshot.ts';
import { executeRunScriptFile } from './run-script-execution.ts';
import {
  MAESTRO_COMPATIBILITY_PRESETS,
  MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
} from './compatibility-policy.ts';
import { maestroTestFailure } from './compatibility-errors.ts';
import { executeMaestroRuntimeCommand } from './runtime-port-commands.ts';
import { observationContext, operationContext } from './runtime-port-context.ts';
import { observeMaestroCondition } from './runtime-port-observation.ts';
import { waitForMaestroAnimationToEnd } from './wait-for-animation-to-end.ts';
import type {
  MaestroObservationIdentity,
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
import {
  MAESTRO_OBSERVATION_POLL_MS,
  captureRetriableMaestroSnapshot,
  observeTypedMaestroCondition,
  resolveTypedMaestroTarget,
  scrollUntilTypedMaestroTarget,
  waitForTypedSnapshotStability,
  maestroSnapshotSignature,
  type MaestroSnapshotReader,
  type MaestroSnapshotSource,
} from './daemon-runtime-port-observation.ts';
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

export type { DaemonMaestroRuntimeDependencies } from './daemon-runtime-port-observation.ts';
export type {
  CreateDaemonMaestroRuntimeOperationsOptions,
  DaemonMaestroRuntimeBaseRequest,
} from './daemon-runtime-port-support.ts';

function createDaemonMaestroRuntimeParts(options: CreateDaemonMaestroRuntimeOperationsOptions): {
  operations: MaestroRuntimeOperations;
  snapshots: MaestroSnapshotSource;
} {
  const snapshots = createSnapshotSource(options);
  const platform = options.platform;
  const invoke = (operation: MaestroPublicOperation) =>
    invokeMaestroPublicOperation(options, operation);
  const invokeMutation = (operation: MaestroPublicOperation) => {
    snapshots.invalidate();
    return invoke(operation);
  };
  const typeTextAndSettle = async (
    text: string,
    context: MaestroRuntimeOperationContext,
  ): Promise<void> => {
    await invokeMutation({ kind: 'typeText', text });
    const snapshot = await waitForTypedSnapshotStability({
      timeoutMs: MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
      context,
      snapshot: snapshots.capture,
      dependencies: options.dependencies,
    });
    snapshots.prime(context.generation, snapshot);
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
      await invokeMutation({
        kind: 'launchApp',
        ...(appId ? { appId } : {}),
        relaunch,
        clearState,
        launchArgs,
      });
    },
    stopApp: async (input, context) => {
      const appId = input.appId ?? context.appId;
      await invokeMutation({ kind: 'stopApp', ...(appId ? { appId } : {}) });
    },
    openLink: async (input, context) => {
      await invokeMutation({
        kind: 'openLink',
        ...(context.appId ? { appId: context.appId } : {}),
        link: input.link,
        prewarmRunner: platform === 'ios',
      });
    },

    tapOn: async (input, context) =>
      await tapTargetAndSettle(options, snapshots, input.target, context, {
        click: {
          count: input.repeat,
          intervalMs: input.delay,
        },
        retryIfNoChange: input.retryTapIfNoChange === true,
      }),
    doubleTapOn: async (input) => {
      snapshots.invalidate();
      await clickTarget(options, input.target.point, {
        doubleTap: true,
        ...(input.delay === undefined ? {} : { intervalMs: input.delay }),
      });
    },
    longPressOn: async (input) => {
      snapshots.invalidate();
      await clickTarget(options, input.target.point, {
        holdMs: MAESTRO_COMPATIBILITY_PRESETS.command.longPressDurationMs,
      });
    },
    gesture: async (input, context) => {
      await invokeMutation({
        kind: 'swipe',
        gesture: input,
        ...(context.gestureViewport ? { viewport: context.gestureViewport } : {}),
      });
      snapshots.requireStability();
    },
    inputText: async (input, context) => await typeTextAndSettle(input.text, context),
    eraseText: async (input, context) =>
      await typeTextAndSettle(
        '\b'.repeat(
          input.charactersToErase ?? MAESTRO_COMPATIBILITY_PRESETS.command.eraseTextMaxCharacters,
        ),
        context,
      ),
    scroll: async (input) => {
      await invokeMutation({ kind: 'scroll', direction: input.direction });
      snapshots.requireStability();
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
        scroll: async (remainingMs) => {
          await invokeMutation({
            kind: 'scroll',
            direction: input.direction,
            durationMs: input.durationMs,
          });
          return await waitForTypedSnapshotStability({
            timeoutMs: Math.min(MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS, remainingMs),
            context,
            snapshot: snapshots.capture,
            dependencies: options.dependencies,
          });
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
    pressKey: async (input) => {
      await invokeMutation({ kind: 'pressKey', key: input.key });
    },
    back: async () => {
      await invokeMutation({ kind: 'pressKey', key: 'back' });
    },
    hideKeyboard: async () => {
      await invokeMutation({ kind: 'pressKey', key: 'dismiss' });
    },
    waitForAnimationToEnd: async (input, context) => {
      await waitForMaestroAnimationToEnd({
        timeoutMs:
          input.timeoutMs ?? MAESTRO_COMPATIBILITY_PRESETS.command.waitForAnimationToEndTimeoutMs,
        now: options.dependencies.now,
        signal: context.signal,
        capture: async (screenshotPath) => {
          await invoke({ kind: 'screenshot', path: screenshotPath, stabilize: false });
        },
      });
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
  return { operations, snapshots };
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
    await sleepBeforeTargetPoll(options, deadline, context.signal);
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

async function sleepBeforeTargetPoll(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const remaining = deadline - options.dependencies.now();
  if (remaining <= 0) return;
  await options.dependencies.sleep(Math.min(MAESTRO_OBSERVATION_POLL_MS, remaining), signal);
}

export function createDaemonMaestroRuntimePort(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
): MaestroRuntimePort {
  const { operations, snapshots } = createDaemonMaestroRuntimeParts(options);
  return {
    execute: async (request: MaestroRuntimeRequest): Promise<MaestroRuntimeResult> => {
      await snapshots.settlePending(operationContext(request, request.command));
      return await executeMaestroRuntimeCommand(request, operations);
    },
    observe: async (request) => {
      await snapshots.settlePending(observationContext(request));
      const observation = await observeMaestroCondition(request, operations);
      return snapshots.bindObservation(observation);
    },
  };
}

function createSnapshotSource(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
): MaestroSnapshotSource {
  let cached:
    | {
        generation: number;
        snapshot: SnapshotState;
        observationIdentity?: MaestroObservationIdentity;
      }
    | undefined;
  let primed: { generation: number; snapshot: SnapshotState } | undefined;
  let stabilityRequired = false;
  let nextObservationIdentity = 0;
  const captureFresh: MaestroSnapshotReader = async (context) => {
    const data = await invokeMaestroPublicOperation(options, {
      kind: 'snapshot',
    });
    if (!data || !Array.isArray(data.nodes)) {
      throw new AppError('COMMAND_FAILED', 'Maestro snapshot did not return node data.');
    }
    const snapshot = data as SnapshotState;
    cached = { generation: context.generation, snapshot };
    return snapshot;
  };
  const capture: MaestroSnapshotReader = async (context) => {
    if (primed?.generation === context.generation) {
      const snapshot = primed.snapshot;
      primed = undefined;
      cached = { generation: context.generation, snapshot };
      return snapshot;
    }
    primed = undefined;
    return await captureFresh(context);
  };
  return {
    capture,
    bindObservation: (observation) => {
      if (cached?.generation !== observation.generation) return observation;
      const identity =
        `maestro-observation-${++nextObservationIdentity}` as MaestroObservationIdentity;
      cached.observationIdentity = identity;
      return { ...observation, identity };
    },
    reuseObservation: (context) => {
      if (context.cachedObservation?.generation !== context.generation) return undefined;
      if (context.cachedObservation.identity === undefined) return undefined;
      if (cached?.generation !== context.generation) return undefined;
      if (context.cachedObservation.identity !== cached.observationIdentity) return undefined;
      return cached.snapshot;
    },
    invalidate: () => {
      cached = undefined;
      primed = undefined;
    },
    requireStability: () => {
      stabilityRequired = true;
      primed = undefined;
    },
    prime: (generation, snapshot) => {
      primed = { generation, snapshot };
    },
    settlePending: async (context) => {
      if (!stabilityRequired) return;
      stabilityRequired = false;
      const snapshot = await waitForTypedSnapshotStability({
        timeoutMs: MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
        context,
        snapshot: captureFresh,
        dependencies: options.dependencies,
      });
      primed = { generation: context.generation, snapshot };
    },
  };
}

async function tapTargetAndSettle(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
  snapshots: MaestroSnapshotSource,
  target: Parameters<MaestroRuntimeOperations['tapOn']>[0]['target'],
  context: MaestroRuntimeOperationContext,
  policy: { click: MaestroClickOptions; retryIfNoChange: boolean },
): Promise<void> {
  const dispatch = async () =>
    await dispatchTapTarget(options, snapshots, target, context, policy.click);
  if (!policy.retryIfNoChange) {
    await dispatch();
    snapshots.requireStability();
    return;
  }

  const baselineSignature =
    target.resolution?.surfaceSignature ??
    maestroSnapshotSignature(await snapshots.capture(context));
  const settle = async () =>
    await waitForTypedSnapshotStability({
      timeoutMs: MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
      context,
      snapshot: snapshots.capture,
      dependencies: options.dependencies,
    });

  await dispatch();
  let observed = await settle();
  let attempts = 1;
  while (
    maestroSnapshotSignature(observed) === baselineSignature &&
    attempts < MAESTRO_COMPATIBILITY_PRESETS.command.retryTapMaxAttempts
  ) {
    await dispatch();
    attempts += 1;
    observed = await settle();
  }
  snapshots.prime(context.generation, observed);
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
    snapshots.invalidate();
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
      snapshots.invalidate();
      await clickTarget(options, pointInsideRect(refreshed.rect), flags);
      return;
    }
  }
  snapshots.invalidate();
  await clickTarget(options, target.point, flags);
}

async function clickSelector(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
  selector: MaestroDispatchSelector,
  expectedPoint: { x: number; y: number },
  flags: MaestroClickOptions,
): Promise<void> {
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
  await invokeMaestroPublicOperation(options, {
    kind: 'clickPoint',
    point,
    options: flags,
  });
}
