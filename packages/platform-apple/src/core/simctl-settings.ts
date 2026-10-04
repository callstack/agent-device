import {
  type MobilePermissionTarget,
  parsePermissionTarget,
} from '@agent-device/contracts/settings';
import { AppError } from '@agent-device/kernel/errors';

/** The `simctl privacy` service for every target except `photos`, whose service depends on its mode. */
const IOS_PRIVACY_SERVICES: Record<Exclude<MobilePermissionTarget, 'photos'>, string> = {
  all: 'all',
  camera: 'camera',
  microphone: 'microphone',
  contacts: 'contacts',
  'contacts-limited': 'contacts-limited',
  notifications: 'notifications',
  calendar: 'calendar',
  location: 'location',
  'location-always': 'location-always',
  'media-library': 'media-library',
  motion: 'motion',
  reminders: 'reminders',
  siri: 'siri',
};

/** The `simctl privacy` service a permission target and optional photos mode select. */
export function parseIosPrivacyService(
  permissionTarget: string | undefined,
  permissionMode: string | undefined,
): string {
  const normalized = parsePermissionTarget(permissionTarget);
  if (normalized === 'photos') {
    const mode = permissionMode?.trim().toLowerCase();
    if (!mode || mode === 'full') return 'photos';
    if (mode === 'limited') return 'photos-add';
    throw new AppError('INVALID_ARGS', `Invalid photos mode: ${permissionMode}. Use full|limited.`);
  }
  if (permissionMode?.trim()) {
    throw new AppError(
      'INVALID_ARGS',
      `Permission mode is only supported for photos. Received: ${permissionMode}.`,
    );
  }
  return IOS_PRIVACY_SERVICES[normalized];
}

/** The appearance `simctl ui appearance` printed, or null when it reported none. */
export function parseIosAppearance(stdout: string, stderr: string): 'light' | 'dark' | null {
  const match = /\b(light|dark|unsupported|unknown)\b/i.exec(`${stdout}\n${stderr}`);
  if (!match) return null;
  const value = match[1]?.toLowerCase();
  if (value === 'dark') return 'dark';
  if (value === 'light') return 'light';
  return null;
}

export type IosPrivacyAction = 'grant' | 'revoke' | 'reset';

/** The `simctl privacy` action a permission state applies. */
export function iosPrivacyAction(action: 'grant' | 'deny' | 'reset'): IosPrivacyAction {
  return action === 'deny' ? 'revoke' : action;
}

/**
 * `simctl privacy` is its own capability check: a service the runtime cannot change answers
 * EPERM, whether or not it is spelled in the help text. The help text is not a capability
 * list — Xcode 26 omits `camera`, which it does change — so the verdict is read from the
 * command that would have made the change rather than from a probe that can only guess.
 */
export function isIosPrivacyServiceRefusal(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'COMMAND_FAILED') return false;
  const stderr = String(error.details?.stderr ?? '').toLowerCase();
  return (
    /failed to (set|grant|revoke|reset) access/.test(stderr) &&
    stderr.includes('operation not permitted')
  );
}

/** The refusal for a `simctl privacy` service the simulator runtime cannot change. */
export function iosPrivacyServiceRefusedError(params: {
  action: IosPrivacyAction;
  target: string;
  appBundleId: string;
  deviceId: string;
  cause: unknown;
}): AppError {
  const { action, target, appBundleId, deviceId, cause } = params;
  if (action === 'reset') {
    return new AppError(
      'UNSUPPORTED_OPERATION',
      `iOS simulator does not support resetting ${target} permission via simctl privacy on this runtime.`,
      {
        deviceId,
        appBundleId,
        hint: 'Use reinstall to force a fresh prompt, or reset simulator content and settings.',
      },
      cause,
    );
  }
  return new AppError(
    'UNSUPPORTED_OPERATION',
    `iOS simulator does not support setting ${target} permission via simctl privacy on this runtime.`,
    {
      deviceId,
      appBundleId,
      hint: 'Privacy support varies by Xcode runtime: run `xcrun simctl privacy help` for its documented services, or use the `all` target, which applies the action to every service this runtime can change.',
    },
    cause,
  );
}
