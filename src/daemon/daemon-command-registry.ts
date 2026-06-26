import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../command-catalog.ts';
import type { DaemonRequest } from './types.ts';

export type DaemonCommandRoute =
  | 'lease'
  | 'session'
  | 'snapshot'
  | 'reactNative'
  | 'recordTrace'
  | 'find'
  | 'interaction'
  | 'generic';

export type SessionCommandKind = 'inventory' | 'state' | 'observability' | 'replay';

type DaemonCommandDescriptor = {
  command: string;
  route: DaemonCommandRoute;
  sessionKind?: SessionCommandKind;
  leaseAdmissionExempt?: boolean;
  sessionExecutionLockExempt?: boolean;
  selectorValidationExempt?: boolean;
  replayScopedAction?: boolean;
  allowInvalidRecording?: boolean;
  lockPolicySelectorOverride?: boolean;
  androidBlockingDialogGuard?: boolean;
  preferExplicitDeviceOverExistingSession?: boolean;
  allowSessionlessDefaultDevice?: (req: DaemonRequest) => boolean;
  skipSessionlessProviderDevice?: (req: DaemonRequest) => boolean;
};

export type DaemonProviderDeviceResolutionIntent =
  | 'existing-session'
  | 'explicit-device'
  | 'sessionless-default-device'
  | 'skip';

const REQUEST_EXECUTION_EXEMPT = {
  leaseAdmissionExempt: true,
  sessionExecutionLockExempt: true,
  selectorValidationExempt: true,
} as const;

const ADMISSION_AND_LOCK_EXEMPT = {
  leaseAdmissionExempt: true,
  sessionExecutionLockExempt: true,
} as const;

const DAEMON_COMMAND_DESCRIPTORS = [
  ...descriptors(
    'lease',
    ADMISSION_AND_LOCK_EXEMPT,
    INTERNAL_COMMANDS.leaseAllocate,
    INTERNAL_COMMANDS.leaseHeartbeat,
    INTERNAL_COMMANDS.leaseRelease,
  ),

  descriptor(INTERNAL_COMMANDS.sessionList, 'session', {
    sessionKind: 'inventory',
    ...REQUEST_EXECUTION_EXEMPT,
  }),
  descriptor(PUBLIC_COMMANDS.devices, 'session', {
    sessionKind: 'inventory',
    lockPolicySelectorOverride: true,
    ...REQUEST_EXECUTION_EXEMPT,
  }),
  descriptor(PUBLIC_COMMANDS.apps, 'session', {
    sessionKind: 'inventory',
    lockPolicySelectorOverride: true,
    preferExplicitDeviceOverExistingSession: true,
  }),
  ...descriptors(
    'session',
    { sessionKind: 'state' },
    PUBLIC_COMMANDS.boot,
    PUBLIC_COMMANDS.shutdown,
    PUBLIC_COMMANDS.appState,
  ),
  ...descriptors(
    'session',
    { sessionKind: 'observability' },
    PUBLIC_COMMANDS.perf,
    PUBLIC_COMMANDS.logs,
    PUBLIC_COMMANDS.network,
  ),
  ...descriptors(
    'session',
    { sessionKind: 'replay', skipSessionlessProviderDevice: isShardedTestRequest },
    PUBLIC_COMMANDS.replay,
    PUBLIC_COMMANDS.test,
  ),
  descriptor(INTERNAL_COMMANDS.runtime, 'session'),
  descriptor(PUBLIC_COMMANDS.clipboard, 'session', { replayScopedAction: true }),
  descriptor(PUBLIC_COMMANDS.keyboard, 'session', {
    replayScopedAction: true,
    androidBlockingDialogGuard: true,
  }),
  ...descriptors(
    'session',
    {},
    PUBLIC_COMMANDS.install,
    PUBLIC_COMMANDS.reinstall,
    INTERNAL_COMMANDS.installSource,
  ),
  descriptor(INTERNAL_COMMANDS.releaseMaterializedPaths, 'session', REQUEST_EXECUTION_EXEMPT),
  ...descriptors('session', {}, PUBLIC_COMMANDS.push, PUBLIC_COMMANDS.triggerAppEvent),
  descriptor(PUBLIC_COMMANDS.open, 'session', {
    allowSessionlessDefaultDevice: () => true,
  }),
  ...descriptors('session', {}, PUBLIC_COMMANDS.prepare, PUBLIC_COMMANDS.batch),
  descriptor(PUBLIC_COMMANDS.close, 'session', { allowInvalidRecording: true }),

  ...descriptors(
    'snapshot',
    { replayScopedAction: true },
    PUBLIC_COMMANDS.snapshot,
    PUBLIC_COMMANDS.diff,
    PUBLIC_COMMANDS.wait,
    PUBLIC_COMMANDS.alert,
    PUBLIC_COMMANDS.settings,
  ),

  descriptor(PUBLIC_COMMANDS.reactNative, 'reactNative', { replayScopedAction: true }),
  descriptor(PUBLIC_COMMANDS.record, 'recordTrace', {
    replayScopedAction: true,
    allowInvalidRecording: true,
    allowSessionlessDefaultDevice: isRecordingStartRequest,
  }),
  descriptor(PUBLIC_COMMANDS.trace, 'recordTrace'),
  descriptor(PUBLIC_COMMANDS.find, 'find', { replayScopedAction: true }),

  ...descriptors(
    'interaction',
    { replayScopedAction: true, androidBlockingDialogGuard: true },
    PUBLIC_COMMANDS.click,
    PUBLIC_COMMANDS.fill,
    PUBLIC_COMMANDS.longPress,
    PUBLIC_COMMANDS.press,
    PUBLIC_COMMANDS.type,
  ),
  ...descriptors(
    'interaction',
    { replayScopedAction: true },
    PUBLIC_COMMANDS.get,
    PUBLIC_COMMANDS.is,
  ),

  ...descriptors(
    'generic',
    { replayScopedAction: true, androidBlockingDialogGuard: true },
    PUBLIC_COMMANDS.back,
    PUBLIC_COMMANDS.gesture,
    PUBLIC_COMMANDS.home,
    PUBLIC_COMMANDS.rotate,
    PUBLIC_COMMANDS.scroll,
    PUBLIC_COMMANDS.swipe,
    'pinch',
  ),
  descriptor(PUBLIC_COMMANDS.focus, 'generic', { androidBlockingDialogGuard: true }),
  descriptor(PUBLIC_COMMANDS.screenshot, 'generic', { replayScopedAction: true }),
  descriptor(PUBLIC_COMMANDS.viewport, 'generic', { replayScopedAction: true }),
  ...descriptors(
    'generic',
    { androidBlockingDialogGuard: true },
    'pan',
    'fling',
    'rotate-gesture',
    'transform-gesture',
  ),
] as const satisfies readonly DaemonCommandDescriptor[];

const DAEMON_COMMAND_REGISTRY = buildDaemonCommandRegistry(DAEMON_COMMAND_DESCRIPTORS);

export function getDaemonCommandRoute(command: string): DaemonCommandRoute {
  return getDaemonCommandDescriptor(command)?.route ?? 'generic';
}

export function getSessionCommandKind(command: string): SessionCommandKind | undefined {
  return getDaemonCommandDescriptor(command)?.sessionKind;
}

export function isLeaseAdmissionExempt(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.leaseAdmissionExempt === true;
}

export function shouldValidateSessionSelector(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.selectorValidationExempt !== true;
}

export function shouldLockSessionExecution(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.sessionExecutionLockExempt !== true;
}

export function canRunReplayScopedAction(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.replayScopedAction === true;
}

export function shouldBlockForInvalidRecording(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.allowInvalidRecording !== true;
}

export function canOverrideLockPolicySelector(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.lockPolicySelectorOverride === true;
}

export function shouldGuardAndroidBlockingDialog(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.androidBlockingDialogGuard === true;
}

export function shouldPreferExplicitDeviceOverExistingSession(req: DaemonRequest): boolean {
  return getDaemonCommandDescriptor(req.command)?.preferExplicitDeviceOverExistingSession === true;
}

export function usesSessionlessDefaultProviderDevice(req: DaemonRequest): boolean {
  const allow = getDaemonCommandDescriptor(req.command)?.allowSessionlessDefaultDevice;
  return typeof allow === 'function' ? allow(req) : false;
}

export function resolveProviderDeviceResolutionIntent(
  req: DaemonRequest,
  params: { hasExistingSession: boolean; hasExplicitDeviceSelector: boolean },
): DaemonProviderDeviceResolutionIntent {
  if (params.hasExistingSession) {
    return shouldPreferExplicitDeviceOverExistingSession(req) && params.hasExplicitDeviceSelector
      ? 'explicit-device'
      : 'existing-session';
  }
  if (shouldSkipSessionlessProviderDevice(req)) return 'skip';
  if (params.hasExplicitDeviceSelector) return 'explicit-device';
  return usesSessionlessDefaultProviderDevice(req) ? 'sessionless-default-device' : 'skip';
}

function descriptor(
  command: string,
  route: DaemonCommandRoute,
  traits: Omit<DaemonCommandDescriptor, 'command' | 'route'> = {},
): DaemonCommandDescriptor {
  return { command, route, ...traits };
}

function descriptors(
  route: DaemonCommandRoute,
  traits: Omit<DaemonCommandDescriptor, 'command' | 'route'>,
  ...commands: readonly string[]
): DaemonCommandDescriptor[] {
  return commands.map((command) => descriptor(command, route, traits));
}

function getDaemonCommandDescriptor(command: string): DaemonCommandDescriptor | undefined {
  return DAEMON_COMMAND_REGISTRY.descriptorsByCommand.get(command);
}

function buildDaemonCommandRegistry(descriptors: readonly DaemonCommandDescriptor[]) {
  const descriptorsByCommand = new Map<string, DaemonCommandDescriptor>();
  for (const descriptor of descriptors) {
    if (descriptorsByCommand.has(descriptor.command)) {
      throw new Error(`Duplicate daemon command descriptor: ${descriptor.command}`);
    }
    descriptorsByCommand.set(descriptor.command, descriptor);
  }
  return { descriptorsByCommand };
}

function isRecordingStartRequest(req: DaemonRequest): boolean {
  return (req.positionals?.[0] ?? '').toLowerCase() === 'start';
}

function shouldSkipSessionlessProviderDevice(req: DaemonRequest): boolean {
  const skip = getDaemonCommandDescriptor(req.command)?.skipSessionlessProviderDevice;
  return typeof skip === 'function' ? skip(req) : false;
}

function isShardedTestRequest(req: DaemonRequest): boolean {
  return (
    req.command === PUBLIC_COMMANDS.test &&
    (typeof req.flags?.shardAll === 'number' || typeof req.flags?.shardSplit === 'number')
  );
}
