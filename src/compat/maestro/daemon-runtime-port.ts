import type { CommandFlags } from '../../core/dispatch.ts';
import { getSnapshotReferenceFrame } from '../../daemon/touch-reference-frame.ts';
import { AppError, asAppError } from '../../kernel/errors.ts';
import type { Rect, SnapshotState } from '../../kernel/snapshot.ts';
import { executeRunScriptFile } from './run-script-execution.ts';
import {
  MAESTRO_COMPATIBILITY_PRESETS,
  MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
} from './compatibility-policy.ts';
import { maestroTestFailure } from './compatibility-errors.ts';
import { executeMaestroRuntimeCommand } from './runtime-port-commands.ts';
import { observeMaestroCondition } from './runtime-port-observation.ts';
import type {
  MaestroObservationIdentity,
  MaestroRuntimePort,
  MaestroRuntimeRequest,
  MaestroRuntimeResult,
} from './engine-types.ts';
import type {
  MaestroDispatchSelector,
  MaestroRuntimeOperationContext,
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
  snapshotViewportRect,
  waitForTypedSnapshotStability,
  type MaestroSnapshotReader,
  type MaestroSnapshotSource,
} from './daemon-runtime-port-observation.ts';
import {
  artifactPathsFromData,
  flagsWith,
  invokeMaestroPublicCommand,
  launchArgumentValues,
  observationFromMatch,
  publicGestureRequest,
  resolveScriptPath,
  stringifyEnvironment,
  type CreateDaemonMaestroRuntimeOperationsOptions,
} from './daemon-runtime-port-support.ts';

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
  const invoke = (
    command: string,
    positionals: string[],
    requestOptions: Parameters<typeof invokeMaestroPublicCommand>[3] = {},
  ) => invokeMaestroPublicCommand(options, command, positionals, requestOptions);
  const invokeMutation = (
    command: string,
    positionals: string[],
    requestOptions: Parameters<typeof invokeMaestroPublicCommand>[3] = {},
  ) => {
    snapshots.invalidate();
    return invoke(command, positionals, requestOptions);
  };
  const typeTextAndSettle = async (
    text: string,
    context: MaestroRuntimeOperationContext,
  ): Promise<void> => {
    await invokeMutation('type', [text]);
    await waitForTypedSnapshotStability({
      timeoutMs: MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
      context,
      snapshot: snapshots.capture,
      dependencies: options.dependencies,
    });
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
      const frame = getSnapshotReferenceFrame(await snapshots.capture(context));
      if (!frame)
        throw new AppError('COMMAND_FAILED', 'Unable to resolve Maestro gesture viewport.');
      return snapshotViewportRect(frame) as Rect;
    },

    launchApp: async (input, context) => {
      const appId = input.appId ?? context.appId;
      const launchArgs = [
        ...launchArgumentValues(input.arguments),
        ...launchArgumentValues(input.launchArguments),
      ];
      const clearState = input.clearState === true;
      const relaunch = !clearState && input.stopApp !== false;
      await invokeMutation('open', appId ? [appId] : [], {
        flags: flagsWith(options.baseReq.flags, {
          ...(relaunch ? { relaunch: true } : {}),
          ...(clearState ? { clearAppState: true } : {}),
          ...(launchArgs.length ? { launchArgs } : {}),
        }),
      });
    },
    stopApp: async (input, context) => {
      const appId = input.appId ?? context.appId;
      await invokeMutation('close', appId ? [appId] : []);
    },
    openLink: async (input, context) => {
      const positionals = context.appId ? [context.appId, input.link] : [input.link];
      await invokeMutation('open', positionals, {
        flags: flagsWith(options.baseReq.flags, {
          ...(platform === 'ios' ? { maestro: { prewarmRunnerBeforeOpen: true } } : {}),
        }),
      });
    },

    tapOn: async (input, context) =>
      await tapTarget(options, snapshots, input.target, context, {
        count: input.repeat,
        intervalMs: input.delay,
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
      const request = publicGestureRequest(input, context);
      await invokeMutation(request.command, [], {
        input: request.input,
        flags: flagsWith(options.baseReq.flags, { postGestureStabilization: false }),
        ...(context.gestureViewport
          ? { internal: { gestureViewport: context.gestureViewport } }
          : {}),
      });
    },
    inputText: async (input, context) => await typeTextAndSettle(input.text, context),
    eraseText: async (input, context) =>
      await typeTextAndSettle('\b'.repeat(input.charactersToErase ?? 50), context),
    pasteText: async (input, context) => await typeTextAndSettle(input.text, context),
    scroll: async (input) => {
      await invokeMutation('scroll', [input.direction], {
        flags: flagsWith(options.baseReq.flags, { postGestureStabilization: false }),
      });
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
          await invokeMutation('scroll', [input.direction], {
            input: { direction: input.direction, durationMs: input.durationMs },
            flags: flagsWith(options.baseReq.flags, { postGestureStabilization: false }),
          });
          return await waitForTypedSnapshotStability({
            timeoutMs: Math.min(MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS, remainingMs),
            context,
            snapshot: snapshots.capture,
            dependencies: options.dependencies,
          });
        },
      });
      if (!match.matched || !match.visible) {
        throw maestroTestFailure('Maestro scrollUntilVisible target did not become visible.', {
          selector: input.selector,
          timeoutMs: input.timeoutMs,
        });
      }
      return { observation: observationFromMatch(input.selector, match) };
    },
    pressKey: async (input) => {
      if (input.key === 'back' || input.key === 'home') {
        await invokeMutation(input.key, []);
        return;
      }
      try {
        await invokeMutation('keyboard', [input.key]);
      } catch (error) {
        if (
          (input.key !== 'enter' && input.key !== 'return') ||
          asAppError(error).code !== 'UNSUPPORTED_OPERATION'
        ) {
          throw error;
        }
        await invokeMutation('type', ['\n']);
      }
    },
    back: async () => {
      await invokeMutation('back', []);
    },
    hideKeyboard: async () => {
      await invokeMutation('keyboard', ['dismiss']);
    },
    waitForAnimationToEnd: async (input, context) => {
      await waitForTypedSnapshotStability({
        timeoutMs:
          input.timeoutMs ?? MAESTRO_COMPATIBILITY_PRESETS.command.waitForAnimationToEndTimeoutMs,
        context,
        snapshot: snapshots.capture,
        dependencies: options.dependencies,
      });
    },
    takeScreenshot: async (input) => ({
      artifactPaths: artifactPathsFromData(await invoke('screenshot', [input.path])),
    }),
    runScript: async (input, context) => ({
      outputEnv: executeRunScriptFile({
        scriptPath: resolveScriptPath(input.file, context, options.sourcePath),
        env: {
          ...context.env,
          ...(input.env ? stringifyEnvironment(input.env) : {}),
          ...(options.baseReq.flags?.maestro?.runScriptEnv ?? {}),
        },
      }),
    }),
  };
  return { operations, snapshots };
}

async function resolveDaemonMaestroTarget(params: {
  input: MaestroTargetQuery & { timeoutMs: number };
  context: MaestroRuntimeOperationContext;
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
    const match = await resolveTypedMaestroTarget({
      query: input,
      context,
      snapshot: currentSnapshot,
      platform: options.platform,
    });
    if (canUseResolvedTarget(match, reusedObservation) || captureStartedAt >= deadline) {
      return match;
    }
    currentSnapshot = undefined;
    if (!reusedObservation) await sleepBeforeTargetPoll(options, deadline, context.signal);
  }
}

function isActionableTarget(match: MaestroTargetMatch): boolean {
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
    execute: async (request: MaestroRuntimeRequest): Promise<MaestroRuntimeResult> =>
      await executeMaestroRuntimeCommand(request, operations),
    observe: async (request) => {
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
  let nextObservationIdentity = 0;
  const capture: MaestroSnapshotReader = async (context) => {
    const data = await invokeMaestroPublicCommand(options, 'snapshot', [], {
      flags: flagsWith(options.baseReq.flags, { noRecord: true }),
    });
    if (!data || !Array.isArray(data.nodes)) {
      throw new AppError('COMMAND_FAILED', 'Maestro snapshot did not return node data.');
    }
    const snapshot = data as SnapshotState;
    cached = { generation: context.generation, snapshot };
    return snapshot;
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
    },
  };
}

async function tapTarget(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
  snapshots: MaestroSnapshotSource,
  target: Parameters<MaestroRuntimeOperations['tapOn']>[0]['target'],
  context: MaestroRuntimeOperationContext,
  flags: Partial<CommandFlags>,
): Promise<void> {
  const dispatchSelector = target.resolution?.dispatchSelector;
  if (dispatchSelector) {
    const resolution = target.resolution!;
    snapshots.invalidate();
    try {
      await clickSelector(options, dispatchSelector, flags);
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
      await clickTarget(options, pointInsideRect(refreshed.rect!), flags);
      return;
    }
  }
  snapshots.invalidate();
  await clickTarget(options, target.point, flags);
}

async function clickSelector(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
  selector: MaestroDispatchSelector,
  flags: Partial<CommandFlags>,
): Promise<void> {
  await invokeMaestroPublicCommand(
    options,
    'click',
    [`${selector.key}=${JSON.stringify(selector.value)}`],
    {
      flags: flagsWith(options.baseReq.flags, {
        ...flags,
        maestro: { allowNonHittableCoordinateFallback: true },
      }),
    },
  );
}

function isAtomicSelectorFallbackError(error: unknown): boolean {
  const code = asAppError(error).code;
  return code === 'AMBIGUOUS_MATCH' || code === 'ELEMENT_NOT_FOUND' || code === 'ELEMENT_OFFSCREEN';
}

async function clickTarget(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
  point: { x: number; y: number } | undefined,
  flags: Partial<CommandFlags>,
): Promise<void> {
  if (!point) throw new AppError('COMMAND_FAILED', 'Maestro target did not resolve to a point.');
  await invokeMaestroPublicCommand(options, 'click', [String(point.x), String(point.y)], {
    flags: flagsWith(options.baseReq.flags, flags),
  });
}
