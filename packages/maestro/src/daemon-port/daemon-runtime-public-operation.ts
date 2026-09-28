import type { CommandFlags } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
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
  | { kind: 'killApp'; appId?: string }
  | { kind: 'clearState'; appId?: string }
  | {
      kind: 'settingsPermission';
      appId?: string;
      state: 'grant' | 'deny' | 'reset';
      permission: string;
      mode?: 'full' | 'limited';
    }
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
  /** With `closeAppOnly`: Maestro `killApp` process death (`am kill` on Android) instead of `stop`. */
  killApp?: true;
  /** A hierarchy capture used as operational evidence only; it issues no client ref authority. */
  observationOnly?: true;
  /** Provider-owned viewport already resolved for a nested gesture command. */
  gestureViewport?: Rect;
  /** Execution profile for timed coordinate swipes projected to `gesture pan`. */
  gestureExecutionProfile?: GestureExecutionProfile;
  /** Maestro `setPermissions` app targeting; the settings handler prefers it over the session app. */
  settingsAppBundleId?: string;
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
  if (operation.kind === 'settingsPermission') return projectSettingsPermission(operation);
  return projectInputOperation(operation);
}

type MaestroAppOperation = Extract<
  MaestroPublicOperation,
  { kind: 'launchApp' | 'stopApp' | 'killApp' | 'openLink' }
>;

function isAppOperation(operation: MaestroPublicOperation): operation is MaestroAppOperation {
  return (
    operation.kind === 'launchApp' ||
    operation.kind === 'stopApp' ||
    operation.kind === 'killApp' ||
    operation.kind === 'openLink'
  );
}

function projectAppOperation(operation: MaestroAppOperation): MaestroDaemonOperationRequest {
  switch (operation.kind) {
    case 'launchApp':
      return projectLaunchApp(operation);
    case 'stopApp':
      return projectStopApp(operation);
    case 'killApp':
      return projectKillApp(operation);
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

function projectKillApp(
  operation: Extract<MaestroAppOperation, { kind: 'killApp' }>,
): MaestroDaemonOperationRequest {
  return {
    command: 'close',
    positionals: operation.appId ? [operation.appId] : [],
    dispatch: { closeAppOnly: true, killApp: true },
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

export type MaestroPermissionMutation = Readonly<
  Pick<
    Extract<MaestroPublicOperation, { kind: 'settingsPermission' }>,
    'state' | 'permission' | 'mode'
  >
>;

/**
 * Maestro permission names and the `settings permission` target each projects onto. Which
 * platform serves a target is the backend's answer, so an unserved target fails there with the
 * backend's own hint; a name missing here is refused before anything is changed.
 */
const MAESTRO_PERMISSION_TARGETS: Readonly<Record<string, string>> = {
  camera: 'camera',
  microphone: 'microphone',
  photos: 'photos',
  contacts: 'contacts',
  notifications: 'notifications',
  calendar: 'calendar',
  location: 'location',
  medialibrary: 'media-library',
  'media-library': 'media-library',
  motion: 'motion',
  reminders: 'reminders',
  siri: 'siri',
};

const MAESTRO_PERMISSION_STATES = { allow: 'grant', deny: 'deny', unset: 'reset' } as const;

/**
 * Maestro's granular values, each already a complete mutation. `inuse` and `never` are not
 * Apple-only spellings to refuse elsewhere: `pm grant` leaves a location appop of `foreground`,
 * which is Android's only allow level, so the plain target is the faithful Android reading of
 * both. `always` and `limited` have no Android mutation to project onto and the Android backend
 * refuses them.
 */
const MAESTRO_GRANULAR_PERMISSIONS: Readonly<
  Record<string, Readonly<Record<string, MaestroPermissionMutation>>>
> = {
  location: {
    always: { state: 'grant', permission: 'location-always' },
    inuse: { state: 'grant', permission: 'location' },
    never: { state: 'deny', permission: 'location' },
  },
  photos: { limited: { state: 'grant', permission: 'photos', mode: 'limited' } },
};

/**
 * A Maestro `setPermissions` map as ordered `settings permission` mutations: `all` first, so the
 * specific entries override it whatever the authored order. The whole map is checked before
 * anything is returned, so a rejected map changes nothing.
 */
export function mapMaestroSetPermissions(
  permissions: Readonly<Record<string, string>>,
): MaestroPermissionMutation[] {
  const entries = Object.entries(permissions).map(
    ([name, value]) => [name.toLowerCase(), value] as const,
  );
  if (entries.length === 0) {
    throw new AppError('INVALID_ARGS', 'Maestro setPermissions requires at least one permission.');
  }
  const ordered = [
    ...entries.filter(([name]) => name === 'all'),
    ...entries.filter(([name]) => name !== 'all'),
  ];
  return ordered.map(([name, value]) => mapMaestroPermission(name, value));
}

function mapMaestroPermission(name: string, value: string): MaestroPermissionMutation {
  const permission = name === 'all' ? 'all' : ownValue(MAESTRO_PERMISSION_TARGETS, name);
  if (permission === undefined) {
    throw new AppError('UNSUPPORTED_OPERATION', `Maestro permission "${name}" is not supported.`, {
      hint: `Supported: all, ${Object.keys(MAESTRO_PERMISSION_TARGETS).join(', ')}.`,
    });
  }
  const granular = MAESTRO_GRANULAR_PERMISSIONS[name];
  const granularMutation = granular ? ownValue(granular, value) : undefined;
  if (granularMutation) return granularMutation;
  const state = ownValue(MAESTRO_PERMISSION_STATES, value);
  if (state) return { state, permission };
  throw new AppError('INVALID_ARGS', `Maestro permission "${name}" does not accept "${value}".`, {
    hint: `Use ${['allow', 'deny', 'unset', ...Object.keys(granular ?? {})].join('|')}.`,
  });
}

function ownValue<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function projectSettingsPermission(
  operation: Extract<MaestroPublicOperation, { kind: 'settingsPermission' }>,
): MaestroDaemonOperationRequest {
  return {
    command: 'settings',
    positionals: [
      'permission',
      operation.state,
      operation.permission,
      ...(operation.mode ? [operation.mode] : []),
    ],
    ...(operation.appId ? { dispatch: { settingsAppBundleId: operation.appId } } : {}),
  };
}

type MaestroInputOperation = Exclude<
  MaestroPublicOperation,
  | MaestroAppOperation
  | MaestroCaptureOperation
  | { kind: 'settingsPermission' }
  | { kind: 'clearState' }
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
