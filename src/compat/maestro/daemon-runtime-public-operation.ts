import type { CommandFlags } from '../../core/dispatch.ts';
import type { DaemonRequest } from '../../daemon/types.ts';
import type { Point, Rect } from '../../kernel/snapshot.ts';
import type {
  MaestroDispatchSelector,
  MaestroSinglePointerGestureInput,
} from './runtime-port-types.ts';

export type MaestroClickOptions = Pick<
  CommandFlags,
  'count' | 'intervalMs' | 'doubleTap' | 'holdMs'
>;

export type MaestroPublicOperation =
  | {
      kind: 'launchApp';
      appId?: string;
      relaunch: boolean;
      clearState: boolean;
      launchArgs: string[];
    }
  | { kind: 'stopApp'; appId?: string }
  | { kind: 'openLink'; appId?: string; link: string; prewarmRunner: boolean }
  | { kind: 'typeText'; text: string }
  | {
      kind: 'clickSelector';
      selector: MaestroDispatchSelector;
      expectedPoint: Point;
      options: MaestroClickOptions;
    }
  | { kind: 'clickPoint'; point: Point; options: MaestroClickOptions }
  | { kind: 'swipe'; gesture: MaestroSinglePointerGestureInput; viewport?: Rect }
  | { kind: 'scroll'; direction: string; durationMs?: number }
  | { kind: 'pressKey'; key: 'back' | 'home' | 'enter' | 'return' | 'dismiss' }
  | { kind: 'screenshot'; path: string; stabilize?: boolean; captureBackend?: 'runner' }
  | { kind: 'snapshot' };

export type ProjectedMaestroPublicOperation = Pick<DaemonRequest, 'command' | 'positionals'> & {
  input?: Record<string, unknown>;
  flags?: Partial<CommandFlags>;
  internal?: DaemonRequest['internal'];
};

export function projectMaestroPublicOperation(
  operation: MaestroPublicOperation,
): ProjectedMaestroPublicOperation {
  if (isAppOperation(operation)) return projectAppOperation(operation);
  if (isCaptureOperation(operation)) return projectCaptureOperation(operation);
  return projectInputOperation(operation);
}

type MaestroAppOperation = Extract<
  MaestroPublicOperation,
  { kind: 'launchApp' | 'stopApp' | 'openLink' }
>;

function isAppOperation(operation: MaestroPublicOperation): operation is MaestroAppOperation {
  return (
    operation.kind === 'launchApp' || operation.kind === 'stopApp' || operation.kind === 'openLink'
  );
}

function projectAppOperation(operation: MaestroAppOperation): ProjectedMaestroPublicOperation {
  switch (operation.kind) {
    case 'launchApp':
      return projectLaunchApp(operation);
    case 'stopApp':
      return projectStopApp(operation);
    case 'openLink':
      return projectOpenLink(operation);
  }
}

function projectLaunchApp(
  operation: Extract<MaestroAppOperation, { kind: 'launchApp' }>,
): ProjectedMaestroPublicOperation {
  return {
    command: 'open',
    positionals: operation.appId ? [operation.appId] : [],
    flags: {
      ...(operation.relaunch ? { relaunch: true } : {}),
      ...(operation.clearState ? { clearAppState: true } : {}),
      ...(operation.launchArgs.length > 0 ? { launchArgs: operation.launchArgs } : {}),
    },
  };
}

function projectStopApp(
  operation: Extract<MaestroAppOperation, { kind: 'stopApp' }>,
): ProjectedMaestroPublicOperation {
  return {
    command: 'close',
    positionals: operation.appId ? [operation.appId] : [],
    internal: { closeAppOnly: true },
  };
}

function projectOpenLink(
  operation: Extract<MaestroAppOperation, { kind: 'openLink' }>,
): ProjectedMaestroPublicOperation {
  return {
    command: 'open',
    positionals: operation.appId ? [operation.appId, operation.link] : [operation.link],
    ...(operation.prewarmRunner ? { flags: { maestro: { prewarmRunnerBeforeOpen: true } } } : {}),
  };
}

type MaestroInputOperation = Exclude<
  MaestroPublicOperation,
  MaestroAppOperation | MaestroCaptureOperation
>;

function projectInputOperation(operation: MaestroInputOperation): ProjectedMaestroPublicOperation {
  switch (operation.kind) {
    case 'typeText':
      return { command: 'type', positionals: [operation.text] };
    case 'clickSelector':
      return projectSelectorClick(operation);
    case 'clickPoint':
      return projectPointClick(operation);
    case 'swipe':
      return projectSwipe(operation);
    case 'scroll':
      return projectScroll(operation);
    case 'pressKey':
      return projectPressKey(operation);
  }
}

function projectSelectorClick(
  operation: Extract<MaestroInputOperation, { kind: 'clickSelector' }>,
): ProjectedMaestroPublicOperation {
  return {
    command: 'click',
    positionals: [`${operation.selector.key}=${JSON.stringify(operation.selector.value)}`],
    flags: {
      ...operation.options,
      maestro: {
        allowNonHittableCoordinateFallback: true,
        expectedTapPoint: operation.expectedPoint,
      },
    },
  };
}

function projectPointClick(
  operation: Extract<MaestroInputOperation, { kind: 'clickPoint' }>,
): ProjectedMaestroPublicOperation {
  return {
    command: 'click',
    positionals: [String(operation.point.x), String(operation.point.y)],
    flags: {
      ...operation.options,
    },
  };
}

function projectSwipe(
  operation: Extract<MaestroInputOperation, { kind: 'swipe' }>,
): ProjectedMaestroPublicOperation {
  return {
    command: 'swipe',
    positionals: [],
    input: operation.gesture,
    flags: { postGestureStabilization: false },
    ...(operation.viewport ? { internal: { gestureViewport: operation.viewport } } : {}),
  };
}

function projectScroll(
  operation: Extract<MaestroInputOperation, { kind: 'scroll' }>,
): ProjectedMaestroPublicOperation {
  return {
    command: 'scroll',
    positionals: [operation.direction],
    ...(operation.durationMs === undefined
      ? {}
      : { input: { direction: operation.direction, durationMs: operation.durationMs } }),
    flags: { postGestureStabilization: false },
  };
}

function projectPressKey(
  operation: Extract<MaestroInputOperation, { kind: 'pressKey' }>,
): ProjectedMaestroPublicOperation {
  if (operation.key === 'back' || operation.key === 'home') {
    return { command: operation.key, positionals: [] };
  }
  return { command: 'keyboard', positionals: [operation.key] };
}

type MaestroCaptureOperation = Extract<MaestroPublicOperation, { kind: 'screenshot' | 'snapshot' }>;

function isCaptureOperation(
  operation: MaestroPublicOperation,
): operation is MaestroCaptureOperation {
  return operation.kind === 'screenshot' || operation.kind === 'snapshot';
}

function projectCaptureOperation(
  operation: MaestroCaptureOperation,
): ProjectedMaestroPublicOperation {
  switch (operation.kind) {
    case 'screenshot':
      return {
        command: 'screenshot',
        positionals: [operation.path],
        ...(operation.stabilize === false || operation.captureBackend === 'runner'
          ? {
              flags: {
                ...(operation.stabilize === false ? { screenshotNoStabilize: true } : {}),
                ...(operation.captureBackend === 'runner'
                  ? { maestro: { screenshotCaptureBackend: 'runner' as const } }
                  : {}),
              },
            }
          : {}),
      };
    case 'snapshot':
      return {
        command: 'snapshot',
        positionals: [],
        flags: { noRecord: true },
      };
  }
}
