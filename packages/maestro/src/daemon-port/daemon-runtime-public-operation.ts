import type { CommandFlags } from '@agent-device/contracts/command';
import type {
  MaestroDispatchSelector,
  MaestroSinglePointerGestureInput,
} from '@agent-device/maestro';
import type { GestureExecutionProfile } from '@agent-device/contracts/gesture-plan-types';
import type { Point, Rect } from '@agent-device/kernel/snapshot';

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
  | { kind: 'clearState'; appId?: string }
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
  | { kind: 'snapshot' }
  | { kind: 'gestureViewport' };

/**
 * What a projected operation asks of the daemon beyond its public command: the daemon translates
 * each option into its own request-private vocabulary before dispatch. Nothing here names live
 * session state, which is what lets the port live outside the daemon.
 */
export type MaestroDaemonDispatchOptions = Readonly<{
  /** Terminate the targeted app without ending the owning daemon session. */
  closeAppOnly?: true;
  /** A hierarchy capture used as operational evidence only; it issues no client ref authority. */
  observationOnly?: true;
  /** Provider-owned viewport already resolved for a nested gesture command. */
  gestureViewport?: Rect;
  /** Execution profile for timed coordinate swipes projected to `gesture pan`. */
  gestureExecutionProfile?: GestureExecutionProfile;
}>;

/**
 * One public daemon command the port asks the daemon to run on the replay's behalf. The daemon
 * owns the rest of the request (token, session, metadata, runtime hints) and folds `dispatch`
 * into its request-private half; the port never sees either.
 */
export type MaestroDaemonOperationRequest = {
  command: string;
  positionals: string[];
  input?: Record<string, unknown>;
  flags?: CommandFlags;
  dispatch?: MaestroDaemonDispatchOptions;
};

export function projectMaestroPublicOperation(
  operation: MaestroPublicOperation,
): MaestroDaemonOperationRequest {
  if (operation.kind === 'clearState') return projectClearState(operation);
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

function projectAppOperation(operation: MaestroAppOperation): MaestroDaemonOperationRequest {
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
): MaestroDaemonOperationRequest {
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
): MaestroDaemonOperationRequest {
  return {
    command: 'close',
    positionals: operation.appId ? [operation.appId] : [],
    dispatch: { closeAppOnly: true },
  };
}

function projectClearState(
  operation: Extract<MaestroPublicOperation, { kind: 'clearState' }>,
): MaestroDaemonOperationRequest {
  return {
    command: 'settings',
    positionals: operation.appId ? ['clear-app-state', operation.appId] : ['clear-app-state'],
  };
}

function projectOpenLink(
  operation: Extract<MaestroAppOperation, { kind: 'openLink' }>,
): MaestroDaemonOperationRequest {
  return {
    command: 'open',
    positionals: operation.appId ? [operation.appId, operation.link] : [operation.link],
    ...(operation.prewarmRunner ? { flags: { maestro: { prewarmRunnerBeforeOpen: true } } } : {}),
  };
}

type MaestroInputOperation = Exclude<
  MaestroPublicOperation,
  MaestroAppOperation | MaestroCaptureOperation | { kind: 'clearState' }
>;

function projectInputOperation(operation: MaestroInputOperation): MaestroDaemonOperationRequest {
  switch (operation.kind) {
    case 'gestureViewport':
      return { command: 'runtime', positionals: ['gesture-viewport'] };
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
): MaestroDaemonOperationRequest {
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
): MaestroDaemonOperationRequest {
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
): MaestroDaemonOperationRequest {
  const { from, to, durationMs } = operation.gesture;
  return {
    command: 'gesture',
    positionals: [],
    input: {
      kind: 'pan',
      origin: from,
      delta: { x: to.x - from.x, y: to.y - from.y },
      durationMs,
    },
    flags: { postGestureStabilization: false },
    dispatch: {
      gestureExecutionProfile: 'endpoint-hold',
      ...(operation.viewport ? { gestureViewport: operation.viewport } : {}),
    },
  };
}

function projectScroll(
  operation: Extract<MaestroInputOperation, { kind: 'scroll' }>,
): MaestroDaemonOperationRequest {
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
): MaestroDaemonOperationRequest {
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
): MaestroDaemonOperationRequest {
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
        dispatch: { observationOnly: true },
      };
  }
}
