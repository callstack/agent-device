import { AppError } from '@agent-device/kernel/errors';
import {
  createMaestroRuntimePort,
  maestroTestFailure,
  MAESTRO_RUNTIME_ADAPTER_POLICY,
  resolveMaestroScrollableGesture,
  type MaestroRuntimeMetrics,
  type MaestroRuntimeOperationContext,
  type MaestroRuntimeOperations,
  type MaestroRuntimePort,
} from '@agent-device/maestro';
import { registerDiagnosticSensitiveValue } from '../../../utils/diagnostics.ts';
import { stripUndefined } from '../../../utils/parsing.ts';
import { executeRunScriptFile } from './run-script-execution.ts';
import { waitForMaestroAnimationToEnd } from './wait-for-animation-to-end.ts';
import {
  observeTypedMaestroCondition,
  scrollUntilTypedMaestroTarget,
  waitForTypedSnapshotStability,
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
import type { MaestroPublicOperation } from './daemon-runtime-public-operation.ts';
import {
  clickMaestroTargetPoint,
  resolveDaemonMaestroTarget,
  tapTargetAndSettle,
} from './daemon-runtime-tap.ts';

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
    registerDiagnosticSensitiveValue(text);
    await invokeMutation({ kind: 'typeText', text }, context);
    const stable = await waitForTypedSnapshotStability({
      timeoutMs: MAESTRO_RUNTIME_ADAPTER_POLICY.settleTimeoutMs,
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
          clickMaestroTargetPoint(
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
          clickMaestroTargetPoint(options, input.target.point, {
            holdMs: MAESTRO_RUNTIME_ADAPTER_POLICY.longPressDurationMs,
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
          input.charactersToErase ?? MAESTRO_RUNTIME_ADAPTER_POLICY.eraseTextMaxCharacters,
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
              timeoutMs: Math.min(MAESTRO_RUNTIME_ADAPTER_POLICY.settleTimeoutMs, remainingMs),
              context,
              snapshot: snapshots.capture,
              dependencies: options.dependencies,
            })
          ).snapshot;
        },
      });
      if (match.visiblePercentage !== MAESTRO_RUNTIME_ADAPTER_POLICY.scrollUntilVisiblePercentage) {
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
        timeoutMs: input.timeoutMs ?? MAESTRO_RUNTIME_ADAPTER_POLICY.animationWaitTimeoutMs,
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

export function createDaemonMaestroRuntimePort(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
): MaestroRuntimePort {
  const { operations, snapshots, readMetrics } = createDaemonMaestroRuntimeParts(options);
  return createMaestroRuntimePort(operations, {
    beforeExecute: async ({ context, requiresSettledPredecessor }) => {
      if (requiresSettledPredecessor) {
        await snapshots.settlePending(context);
      }
    },
    afterExecute: ({ context, visualStabilityReached }) => {
      if (visualStabilityReached) {
        snapshots.consumeStabilityFromVisualWait(context);
      }
    },
    bindObservation: snapshots.bindObservation,
    readMetrics,
  });
}
