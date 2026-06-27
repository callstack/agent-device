import { AppError } from '../utils/errors.ts';
import type { CommandFlags } from '../core/dispatch.ts';
import type { SessionState } from './types.ts';
import { matchesPlatformSelector } from '../utils/device.ts';
import { parseSerialAllowlist } from '../utils/device-isolation.ts';
import { buildSessionRecoveryHint, describeSessionDevice } from './session-recovery-hints.ts';

export type SessionSelectorConflictKey =
  | 'platform'
  | 'target'
  | 'udid'
  | 'serial'
  | 'device'
  | 'iosSimulatorDeviceSet'
  | 'androidDeviceAllowlist';

export type SessionSelectorConflict = {
  key: SessionSelectorConflictKey;
  value: string;
};

export function assertSessionSelectorMatches(session: SessionState, flags?: CommandFlags): void {
  const mismatches = listSessionSelectorConflicts(session, flags);
  if (mismatches.length === 0) return;

  throw new AppError(
    'INVALID_ARGS',
    `Session "${session.name}" is already bound to ${describeSessionDevice(session)}, but this request selected ${mismatches.map(formatSessionSelectorConflict).join(', ')}.`,
    {
      session: session.name,
      conflicts: mismatches.map(formatSessionSelectorConflict),
      hint: buildSessionRecoveryHint(session, 'selector-conflict'),
    },
  );
}

export function listSessionSelectorConflicts(
  session: SessionState,
  flags?: CommandFlags,
): SessionSelectorConflict[] {
  if (!flags) return [];

  const mismatches: SessionSelectorConflict[] = [];
  const device = session.device;

  const normalizedPlatform = flags.platform;
  if (normalizedPlatform && !matchesPlatformSelector(device.platform, normalizedPlatform)) {
    mismatches.push({ key: 'platform', value: flags.platform! });
  }
  if (flags.target && flags.target !== (device.target ?? 'mobile')) {
    mismatches.push({ key: 'target', value: flags.target });
  }

  if (flags.udid && (device.platform !== 'ios' || flags.udid !== device.id)) {
    mismatches.push({ key: 'udid', value: flags.udid });
  }

  if (flags.serial && (device.platform !== 'android' || flags.serial !== device.id)) {
    mismatches.push({ key: 'serial', value: flags.serial });
  }

  if (flags.device && flags.device.trim().toLowerCase() !== device.name.trim().toLowerCase()) {
    mismatches.push({ key: 'device', value: flags.device });
  }

  if (flags.iosSimulatorDeviceSet) {
    const requestedSetPath = flags.iosSimulatorDeviceSet.trim();
    const sessionSetPath = device.simulatorSetPath?.trim();
    if (
      device.platform !== 'ios' ||
      device.kind !== 'simulator' ||
      requestedSetPath !== sessionSetPath
    ) {
      mismatches.push({ key: 'iosSimulatorDeviceSet', value: flags.iosSimulatorDeviceSet });
    }
  }

  if (flags.androidDeviceAllowlist) {
    const allowlist = parseSerialAllowlist(flags.androidDeviceAllowlist);
    if (device.platform !== 'android' || !allowlist.has(device.id)) {
      mismatches.push({ key: 'androidDeviceAllowlist', value: flags.androidDeviceAllowlist });
    }
  }

  return mismatches;
}

export function formatSessionSelectorConflict(conflict: SessionSelectorConflict): string {
  return `${flagNameForConflictKey(conflict.key)}=${conflict.value}`;
}

function flagNameForConflictKey(key: SessionSelectorConflictKey): string {
  switch (key) {
    case 'iosSimulatorDeviceSet':
      return '--ios-simulator-device-set';
    case 'androidDeviceAllowlist':
      return '--android-device-allowlist';
    default:
      return `--${key}`;
  }
}
