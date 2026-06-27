import { AppError } from '../utils/errors.ts';
import type { CommandFlags } from '../core/dispatch.ts';
import type { SessionState, DaemonRequest } from './types.ts';
import {
  formatSessionSelectorConflict,
  listSessionSelectorConflicts,
  type SessionSelectorConflict,
  type SessionSelectorConflictKey,
} from './session-selector.ts';
import { isApplePlatform, type PlatformSelector } from '../utils/device.ts';
import { buildSessionRecoveryHint, describeSessionDevice } from './session-recovery-hints.ts';
import { shellQuoteIfNeeded } from '../utils/shell-quote.ts';
import { hasLockableDeviceSelector, hasSelectorValue } from './device-selector-intent.ts';
import { canOverrideLockPolicySelector } from './daemon-command-registry.ts';

type LockPlatform = NonNullable<DaemonRequest['meta']>['lockPlatform'];
type NormalizedLockPlatform = NonNullable<PlatformSelector>;

export function applyRequestLockPolicy(
  req: DaemonRequest,
  existingSession?: SessionState,
): DaemonRequest {
  const lockPolicy = req.meta?.lockPolicy;
  if (!lockPolicy) {
    return req;
  }

  const nextFlags: CommandFlags = { ...(req.flags ?? {}) };
  const canOverrideSelector = canOverrideLockPolicySelector(req.command);
  const conflicts = canOverrideSelector
    ? []
    : existingSession
      ? listSessionSelectorConflicts(existingSession, nextFlags)
      : listFreshSessionConflicts(nextFlags, req.meta?.lockPlatform);
  const lockPlatform = req.meta?.lockPlatform;

  if (conflicts.length === 0) {
    if (
      shouldApplyLockPlatformDefault(canOverrideSelector, existingSession, nextFlags, lockPlatform)
    ) {
      nextFlags.platform = lockPlatform;
    }
    return {
      ...req,
      flags: nextFlags,
    };
  }

  if (lockPolicy === 'strip') {
    applyStripLockPolicy(nextFlags, conflicts, lockPlatform, existingSession);
    return {
      ...req,
      flags: nextFlags,
    };
  }

  throw new AppError(
    'INVALID_ARGS',
    buildLockPolicyConflictMessage(req, conflicts, existingSession),
    {
      session: req.session,
      conflicts: conflicts.map(formatSessionSelectorConflict),
      hint: buildLockPolicyConflictHint(req, existingSession),
    },
  );
}

function buildLockPolicyConflictMessage(
  req: DaemonRequest,
  conflicts: SessionSelectorConflict[],
  existingSession: SessionState | undefined,
): string {
  const conflictList = conflicts.map(formatSessionSelectorConflict).join(', ');
  if (existingSession) {
    return (
      `${req.command} is already bound to session "${existingSession.name}" on ${describeSessionDevice(existingSession)}, ` +
      `but this request selected ${conflictList}.`
    );
  }
  const lockPlatform = req.meta?.lockPlatform;
  const platformText = lockPlatform ? ` for ${lockPlatform}` : '';
  return `${req.command} is using a bound-session lock${platformText}, but this request selected ${conflictList}.`;
}

function buildLockPolicyConflictHint(
  req: DaemonRequest,
  existingSession: SessionState | undefined,
): string {
  if (existingSession) {
    return buildSessionRecoveryHint(existingSession, 'selector-conflict');
  }
  const lockPlatform = req.meta?.lockPlatform;
  const sessionText = req.session ? ` --session ${shellQuoteIfNeeded(req.session)}` : '';
  const openText = lockPlatform
    ? `Run agent-device open <app>${sessionText} --platform ${lockPlatform} first if no session is active. `
    : `Run agent-device open <app>${sessionText} first if no session is active. `;
  return (
    `Remove conflicting device selectors from this command, or use --session-lock strip to let agent-device ignore them. ` +
    openText +
    `Run agent-device session list to inspect active sessions.`
  );
}

function shouldApplyLockPlatformDefault(
  canOverrideSelector: boolean,
  existingSession: SessionState | undefined,
  flags: CommandFlags,
  lockPlatform: LockPlatform,
): boolean {
  if (!lockPlatform || existingSession || flags.platform !== undefined) {
    return false;
  }
  if (!canOverrideSelector) {
    return true;
  }
  return !hasLockableDeviceSelector(flags);
}

function applyStripLockPolicy(
  flags: CommandFlags,
  conflicts: SessionSelectorConflict[],
  lockPlatform: LockPlatform,
  existingSession: SessionState | undefined,
): void {
  if (existingSession) {
    stripSessionConflicts(flags, conflicts);
    flags.platform = existingSession.device.platform;
    return;
  }
  stripSessionConflicts(flags, conflicts);
  if (lockPlatform && flags.platform === undefined) {
    flags.platform = lockPlatform;
  }
}

function listFreshSessionConflicts(
  flags: CommandFlags,
  lockPlatform: LockPlatform,
): SessionSelectorConflict[] {
  // Fresh sessions are not device-bound yet. Reject only selectors that cannot
  // participate in the first binding for the locked platform; concrete device
  // existence and identity remain the target resolver's job.
  const conflicts: SessionSelectorConflict[] = [];
  const normalizedLockPlatform = lockPlatform;
  if (
    flags.platform !== undefined &&
    normalizedLockPlatform &&
    platformSelectorsConflict(flags.platform, normalizedLockPlatform)
  ) {
    conflicts.push({ key: 'platform', value: flags.platform });
  }
  if (!normalizedLockPlatform) {
    return conflicts;
  }
  appendFreshSessionTargetConflict(conflicts, flags, normalizedLockPlatform);
  appendFreshSessionDeviceSelectorConflicts(conflicts, flags, normalizedLockPlatform);
  return conflicts;
}

function platformSelectorsConflict(
  requested: PlatformSelector | undefined,
  locked: PlatformSelector | undefined,
): boolean {
  if (!requested || !locked) return false;
  if (requested === locked) return false;
  if (requested === 'apple') return !isApplePlatform(locked);
  if (locked === 'apple') return !isApplePlatform(requested);
  return true;
}

function appendFreshSessionTargetConflict(
  conflicts: SessionSelectorConflict[],
  flags: CommandFlags,
  lockPlatform: NormalizedLockPlatform,
): void {
  const target = flags.target;
  if (!target) return;
  if (targetSelectorsConflict(target, lockPlatform)) {
    conflicts.push({ key: 'target', value: target });
  }
}

function targetSelectorsConflict(
  target: NonNullable<CommandFlags['target']>,
  lockPlatform: NormalizedLockPlatform,
): boolean {
  switch (lockPlatform) {
    case 'android':
    case 'ios':
      return target === 'desktop';
    case 'macos':
    case 'linux':
    case 'web':
      return target !== 'desktop';
    case 'apple':
      return false;
    default:
      return assertNever(lockPlatform);
  }
}

function appendFreshSessionDeviceSelectorConflicts(
  conflicts: SessionSelectorConflict[],
  flags: CommandFlags,
  lockPlatform: NormalizedLockPlatform,
): void {
  for (const key of freshSessionSelectorKeysForPlatform(lockPlatform, flags)) {
    const value = flags[key];
    if (hasSelectorValue(value)) {
      conflicts.push({ key, value });
    }
  }
}

function freshSessionSelectorKeysForPlatform(
  lockPlatform: NormalizedLockPlatform,
  flags: CommandFlags,
): SessionSelectorConflictKey[] {
  switch (lockPlatform) {
    case 'android':
      return ['udid', 'iosSimulatorDeviceSet'];
    case 'ios':
      return ['serial', 'androidDeviceAllowlist'];
    case 'apple':
      return isAppleDesktopSelector(flags)
        ? ['udid', 'serial', 'androidDeviceAllowlist', 'iosSimulatorDeviceSet']
        : ['serial', 'androidDeviceAllowlist'];
    case 'macos':
    case 'linux':
    case 'web':
      return ['udid', 'serial', 'iosSimulatorDeviceSet', 'androidDeviceAllowlist'];
    default:
      return assertNever(lockPlatform);
  }
}

function isAppleDesktopSelector(flags: CommandFlags): boolean {
  return flags.target === 'desktop' || flags.platform === 'macos';
}

function stripSessionConflicts(flags: CommandFlags, conflicts: SessionSelectorConflict[]): void {
  for (const conflict of conflicts) {
    delete flags[conflict.key];
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled lock platform: ${String(value)}`);
}
