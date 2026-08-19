import type { CommandFlags } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import type { SessionState, DaemonRequest } from './types.ts';
import {
  formatSessionSelectorConflict,
  listSessionSelectorConflicts,
  type SessionSelectorConflict,
  type SessionSelectorConflictKey,
} from './session-selector.ts';
import {
  isApplePlatform,
  publicPlatformString,
  type PlatformSelector,
} from '@agent-device/kernel/device';
import { buildSessionRecoveryHint, describeSessionDevice } from './session-recovery-hints.ts';
import { shellQuoteIfNeeded } from '../utils/shell-quote.ts';
import { hasLockableDeviceSelector, hasSelectorValue } from './device-selector-intent.ts';
import { canOverrideLockPolicySelector } from './daemon-command-registry.ts';

type LockPlatform = NonNullable<DaemonRequest['meta']>['lockPlatform'];
type NormalizedLockPlatform = NonNullable<PlatformSelector>;

/**
 * Selectors that name WHICH device, as opposed to narrowing the pool it is chosen from. A conflict
 * on one of these cannot be resolved by dropping it: the request asked for device A while the lock
 * names device B, and both cannot be honored. Such a conflict always fails, whatever the lock
 * policy — `strip` used to delete the selector and continue against the bound device, which is
 * silently-wrong automation rather than a loud failure.
 */
const DEVICE_IDENTITY_CONFLICT_KEYS: ReadonlySet<SessionSelectorConflictKey> = new Set([
  'udid',
  'serial',
  'device',
]);

function isDeviceIdentityConflict(conflict: SessionSelectorConflict): boolean {
  return DEVICE_IDENTITY_CONFLICT_KEYS.has(conflict.key);
}

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

  const identityConflicts = conflicts.filter(isDeviceIdentityConflict);
  if (lockPolicy === 'strip' && identityConflicts.length === 0) {
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
      ...describeConflictingIdentities(identityConflicts, existingSession),
      hint: buildLockPolicyConflictHint(req, existingSession, identityConflicts),
    },
  );
}

/**
 * Both sides of an identity conflict, structured: what the request asked for and what the lock is
 * bound to. A caller deciding which of the two recoveries to take needs the identities, not prose.
 */
function describeConflictingIdentities(
  identityConflicts: SessionSelectorConflict[],
  existingSession: SessionState | undefined,
): Record<string, unknown> {
  if (identityConflicts.length === 0) return {};
  return {
    requestedDevice: Object.fromEntries(
      identityConflicts.map((conflict) => [conflict.key, conflict.value]),
    ),
    ...(existingSession
      ? {
          boundDevice: {
            platform: existingSession.device.platform,
            name: existingSession.device.name,
            id: existingSession.device.id,
          },
        }
      : {}),
  };
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
  identityConflicts: SessionSelectorConflict[],
): string {
  // `buildSessionRecoveryHint` already states the two recoveries (close the bound session, or drop
  // the selectors) and never mentions --session-lock, so a bound session needs no identity branch.
  if (existingSession) {
    return buildSessionRecoveryHint(existingSession, 'selector-conflict');
  }
  const lockPlatform = req.meta?.lockPlatform;
  const sessionText = req.session ? ` --session ${shellQuoteIfNeeded(req.session)}` : '';
  const openText = lockPlatform
    ? `Run agent-device open <app>${sessionText} --platform ${lockPlatform} first if no session is active. `
    : `Run agent-device open <app>${sessionText} first if no session is active. `;
  if (identityConflicts.length > 0) {
    // NEVER offer --session-lock strip here: stripping a device identity keeps the request running
    // against the OTHER device, which is the failure this rejection exists to prevent.
    const selectorList = identityConflicts.map(formatSessionSelectorConflict).join(', ');
    return (
      `Remove ${selectorList} and rerun to use the session-lock device, ` +
      `or drop --session so this command binds to the device you selected. ` +
      openText +
      `Run agent-device session list to inspect active sessions.`
    );
  }
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
    // approach (b): backfill the request selector with the PUBLIC leaf platform, not
    // the internal `apple` — the leaf selector still matches the session's Apple device.
    flags.platform = publicPlatformString(existingSession.device);
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
    case 'harmonyos':
    case 'ios':
      return target === 'desktop';
    case 'vega':
      return target !== 'tv';
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
  if (isAndroidLikeLockPlatform(lockPlatform)) {
    return ['udid', 'iosSimulatorDeviceSet'];
  }
  switch (lockPlatform) {
    case 'vega':
      return ['udid', 'iosSimulatorDeviceSet', 'androidDeviceAllowlist'];
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

function isAndroidLikeLockPlatform(
  platform: NormalizedLockPlatform,
): platform is 'android' | 'harmonyos' {
  return platform === 'android' || platform === 'harmonyos';
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
