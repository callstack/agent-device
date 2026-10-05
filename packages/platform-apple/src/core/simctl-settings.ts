import {
  type MobilePermissionTarget,
  parseAppearanceAction,
  parsePermissionAction,
  parsePermissionTarget,
  parseSettingState,
  type SimctlSettingRequest,
} from '@agent-device/contracts/settings';
import { AppError, sessionAppRequiredDetails } from '@agent-device/kernel/errors';
import { requireLocationCoordinates } from '@agent-device/kernel/location-coordinates';

/** Changes one simulator setting through `simctl`; the Apple package owns this plan for every runner. */
export async function applySimctlSetting(
  request: SimctlSettingRequest,
): Promise<Record<string, unknown> | void> {
  switch (request.setting) {
    case 'appearance':
      return await setAppearance(request);
    case 'permission':
      return await setPermission(request);
    case 'location':
      return await setLocation(request);
  }
}

async function setAppearance({ runSimctl, udid, state }: SimctlSettingRequest): Promise<void> {
  const action = parseAppearanceAction(state);
  let target: 'light' | 'dark';
  if (action === 'toggle') {
    const current = await runSimctl(['ui', udid, 'appearance']);
    const appearance = parseIosAppearance(current.stdout, current.stderr);
    if (!appearance) {
      throw new AppError(
        'COMMAND_FAILED',
        'Unable to determine current iOS appearance for toggle',
        {
          stdout: current.stdout,
          stderr: current.stderr,
        },
      );
    }
    target = appearance === 'dark' ? 'light' : 'dark';
  } else {
    target = action;
  }
  await runSimctl(['ui', udid, 'appearance', target]);
}

async function setPermission(request: SimctlSettingRequest): Promise<void> {
  const { runSimctl, udid, deviceId, state, options } = request;
  const appBundleId = requireAppBundleId(request);
  const permissionAction = parsePermissionAction(state);
  const action = permissionAction === 'deny' ? 'revoke' : permissionAction;
  const target = parseIosPrivacyService(options?.permissionTarget, options?.permissionMode);
  try {
    await runSimctl(['privacy', udid, action, target, appBundleId]);
  } catch (error) {
    if (!isIosPrivacyServiceRefusal(error)) throw error;
    throw iosPrivacyServiceRefusedError(action, target, appBundleId, deviceId, error);
  }
}

async function setLocation(request: SimctlSettingRequest): Promise<Record<string, unknown> | void> {
  const { runSimctl, udid, state, options } = request;
  if (state.toLowerCase() === 'set') {
    const { latitude, longitude } = requireLocationCoordinates(options);
    await runSimctl(['location', udid, 'set', `${latitude},${longitude}`]);
    return { latitude, longitude };
  }
  const action = parseSettingState(state) ? 'grant' : 'revoke';
  await runSimctl(['privacy', udid, action, 'location', requireAppBundleId(request)]);
}

function requireAppBundleId({ setting, appBundleId }: SimctlSettingRequest): string {
  if (appBundleId) return appBundleId;
  throw new AppError(
    'INVALID_ARGS',
    `${setting} setting requires an active app in session`,
    sessionAppRequiredDetails(),
  );
}

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

function parseIosPrivacyService(
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

function parseIosAppearance(stdout: string, stderr: string): 'light' | 'dark' | null {
  const match = /\b(light|dark|unsupported|unknown)\b/i.exec(`${stdout}\n${stderr}`);
  if (!match) return null;
  const value = match[1]?.toLowerCase();
  if (value === 'dark') return 'dark';
  if (value === 'light') return 'light';
  return null;
}

/**
 * `simctl privacy` is its own capability check: a service the runtime cannot change answers
 * EPERM, whether or not it is spelled in the help text. The help text is not a capability
 * list — Xcode 26 omits `camera`, which it does change — so the verdict is read from the
 * command that would have made the change rather than from a probe that can only guess.
 */
function isIosPrivacyServiceRefusal(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'COMMAND_FAILED') return false;
  const stderr = String(error.details?.stderr ?? '').toLowerCase();
  return (
    /failed to (set|grant|revoke|reset) access/.test(stderr) &&
    stderr.includes('operation not permitted')
  );
}

function iosPrivacyServiceRefusedError(
  action: 'grant' | 'revoke' | 'reset',
  target: string,
  appBundleId: string,
  deviceId: string,
  cause: unknown,
): AppError {
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
