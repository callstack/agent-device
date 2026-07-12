import type { CommandFlags } from '../../core/dispatch.ts';
import { getSnapshotReferenceFrame } from '../../daemon/touch-reference-frame.ts';
import { AppError } from '../../kernel/errors.ts';
import type { Rect, SnapshotState } from '../../kernel/snapshot.ts';
import { executeRunScriptFile } from './run-script-execution.ts';
import { executeMaestroRuntimeCommand } from './runtime-port-commands.ts';
import { observeMaestroCondition } from './runtime-port-observation.ts';
import type {
  MaestroRuntimePort,
  MaestroRuntimeRequest,
  MaestroRuntimeResult,
} from './engine-types.ts';
import type { MaestroRuntimeOperations } from './runtime-port-types.ts';
import {
  observeTypedMaestroCondition,
  resolveTypedMaestroPreferredContext,
  resolveTypedMaestroTarget,
  scrollUntilTypedMaestroTarget,
  snapshotViewportRect,
  waitForTypedSnapshotStability,
  type MaestroSnapshotReader,
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

export function createDaemonMaestroRuntimeOperations(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
): MaestroRuntimeOperations {
  const snapshot = createSnapshotReader(options);
  const platform = options.platform;
  const invoke = (
    command: string,
    positionals: string[],
    requestOptions: { input?: Record<string, unknown>; flags?: CommandFlags } = {},
  ) => invokeMaestroPublicCommand(options, command, positionals, requestOptions);

  const operations: MaestroRuntimeOperations = {
    resolveTarget: async (input, context) => {
      const currentSnapshot = await snapshot(context);
      const evidence = context.cachedObservation?.evidence;
      const preferredContext =
        evidence && evidence.visible
          ? resolveTypedMaestroPreferredContext({
              selector: evidence.selector,
              snapshot: currentSnapshot,
              platform,
            })
          : undefined;
      return await resolveTypedMaestroTarget({
        query: input,
        context,
        snapshot: currentSnapshot,
        platform,
        preferredContext,
      });
    },
    observe: async (input, context) =>
      await observeTypedMaestroCondition({
        condition: input.condition,
        timeoutMs: input.timeoutMs,
        context,
        snapshot,
        dependencies: options.dependencies,
        platform,
      }),
    resolveGestureViewport: async (context) => {
      const frame = getSnapshotReferenceFrame(await snapshot(context));
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
      await invoke('open', appId ? [appId] : [], {
        flags: flagsWith(options.baseReq.flags, {
          ...(relaunch ? { relaunch: true } : {}),
          ...(clearState ? { clearAppState: true } : {}),
          ...(launchArgs.length ? { launchArgs } : {}),
        }),
      });
    },
    stopApp: async (input, context) => {
      const appId = input.appId ?? context.appId;
      await invoke('close', appId ? [appId] : []);
    },
    openLink: async (input, context) => {
      const positionals = context.appId ? [context.appId, input.link] : [input.link];
      await invoke('open', positionals, {
        flags: flagsWith(options.baseReq.flags, {
          ...(platform === 'ios' ? { maestro: { prewarmRunnerBeforeOpen: true } } : {}),
        }),
      });
    },

    tapOn: async (input) =>
      await clickTarget(options, input.target.point, {
        count: input.repeat,
        intervalMs: input.delay,
        postGestureStabilization: true,
      }),
    doubleTapOn: async (input) =>
      await clickTarget(options, input.target.point, {
        doubleTap: true,
        ...(input.delay === undefined ? {} : { intervalMs: input.delay }),
        postGestureStabilization: true,
      }),
    longPressOn: async (input) =>
      await clickTarget(options, input.target.point, {
        holdMs: 3_000,
        postGestureStabilization: true,
      }),
    gesture: async (input, context) => {
      const request = publicGestureRequest(input, context);
      await invoke(request.command, [], { input: request.input });
    },
    inputText: async (input) => {
      await invoke('type', [input.text]);
    },
    eraseText: async (input) => {
      await invoke('type', ['\b'.repeat(input.charactersToErase ?? 50)]);
    },
    pasteText: async (input) => {
      await invoke('type', [input.text]);
    },
    scroll: async (input) => {
      await invoke('scroll', [input.direction]);
    },
    scrollUntilVisible: async (input, context) => {
      const match = await scrollUntilTypedMaestroTarget({
        selector: input.selector,
        direction: input.direction,
        timeoutMs: input.timeoutMs,
        context,
        snapshot,
        dependencies: options.dependencies,
        platform,
        scroll: async () => {
          await invoke('scroll', [input.direction]);
        },
      });
      return { observation: observationFromMatch(input.selector, match) };
    },
    pressKey: async (input) => {
      if (input.key === 'back' || input.key === 'home') {
        await invoke(input.key, []);
        return;
      }
      try {
        await invoke('keyboard', [input.key]);
      } catch (error) {
        if (input.key !== 'enter' && input.key !== 'return') throw error;
        await invoke('type', ['\n']);
      }
    },
    back: async () => {
      await invoke('back', []);
    },
    hideKeyboard: async () => {
      await invoke('keyboard', ['dismiss']);
    },
    waitForAnimationToEnd: async (input, context) =>
      await waitForTypedSnapshotStability({
        timeoutMs: input.timeoutMs ?? 15_000,
        context,
        snapshot,
        dependencies: options.dependencies,
      }),
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
  return operations;
}

export function createDaemonMaestroRuntimePort(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
): MaestroRuntimePort {
  const operations = createDaemonMaestroRuntimeOperations(options);
  return {
    execute: async (request: MaestroRuntimeRequest): Promise<MaestroRuntimeResult> =>
      await executeMaestroRuntimeCommand(request, operations),
    observe: async (request) => await observeMaestroCondition(request, operations),
  };
}

function createSnapshotReader(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
): MaestroSnapshotReader {
  return async () => {
    const data = await invokeMaestroPublicCommand(options, 'snapshot', [], {
      flags: flagsWith(options.baseReq.flags, { noRecord: true }),
    });
    if (!data || !Array.isArray(data.nodes)) {
      throw new AppError('COMMAND_FAILED', 'Maestro snapshot did not return node data.');
    }
    return data as SnapshotState;
  };
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
