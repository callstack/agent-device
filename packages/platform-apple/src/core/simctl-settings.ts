import {
  parseAppearanceAction,
  parsePermissionAction,
  parsePermissionTarget,
  parseSettingState,
  type SimctlSettingRequest,
} from '@agent-device/contracts/settings';
import { type MobilePermissionTarget } from '@agent-device/contracts/settings-catalog';
import { AppError, sessionAppRequiredDetails, type ReasonTable } from '@agent-device/kernel/errors';
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

const SIMCTL_SETTINGS_REASONS = {
  // iOS simulator notification prompts must be answered with `alert accept` or `alert dismiss`.
  notificationsUnsupported: { reason: 'ios-notification-permission-unsupported' },
} as const satisfies ReasonTable<'settings'>;

async function setPermission(
  request: SimctlSettingRequest,
): Promise<Record<string, unknown> | void> {
  const { runSimctl, udid, deviceId, state, options } = request;
  const permissionAction = parsePermissionAction(state);
  const action = permissionAction === 'deny' ? 'revoke' : permissionAction;
  const target = parseIosPrivacyService(options?.permissionTarget, options?.permissionMode);
  if (target === 'notifications') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'iOS simulators do not support changing notification permissions through settings permission.',
      {
        reason: SIMCTL_SETTINGS_REASONS.notificationsUnsupported.reason,
        dispatched: 'no',
        deviceId,
        hint: 'Use `alert accept` or `alert dismiss` to answer the notification prompt.',
      },
    );
  }
  const appBundleId = await requireAppBundleId(request);
  if (target === 'all' && action !== 'reset') {
    return await setEveryIosPrivacyService(request, action, appBundleId);
  }
  try {
    await runSimctl(['privacy', udid, action, target, appBundleId]);
  } catch (error) {
    if (!isIosPrivacyServiceRefusal(error)) throw error;
    throw iosPrivacyServiceRefusedError(action, target, appBundleId, deviceId, error);
  }
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

/**
 * Whether a grant or revoke of `all` changes each target's service, keyed by every target so a new
 * one cannot be left out without a compile error. `all` takes the widest access each service
 * offers: full contacts and photos, and location always, which `simctl privacy grant all` gave
 * too. The narrower targets are left to the row they share: limited contacts write the `contacts`
 * row, and revoking `location-always` takes back while-in-use access too (iOS 27.2).
 */
const IOS_ALL_TARGETS = {
  calendar: true,
  camera: true,
  contacts: true,
  'contacts-limited': false,
  location: false,
  'location-always': true,
  'media-library': true,
  microphone: true,
  motion: true,
  notifications: true,
  photos: true,
  reminders: true,
  siri: true,
} as const satisfies Record<Exclude<MobilePermissionTarget, 'all'>, boolean>;

/** The services a grant of `all` changes, one `simctl privacy` call each. */
const IOS_ALL_GRANTED_SERVICES: readonly string[] = (
  Object.keys(IOS_ALL_TARGETS) as (keyof typeof IOS_ALL_TARGETS)[]
)
  .filter((target) => IOS_ALL_TARGETS[target])
  .map((target) => (target === 'photos' ? 'photos' : IOS_PRIVACY_SERVICES[target]));

/**
 * The services a revoke of `all` changes: every granted one, and limited photo access
 * (`photos-add`), a service of its own that revoking `photos` leaves in place.
 */
const IOS_ALL_REVOKED_SERVICES: readonly string[] = [...IOS_ALL_GRANTED_SERVICES, 'photos-add'];

/**
 * `all` for grant and revoke, as one `simctl privacy` call per service. The simulator records
 * `simctl privacy grant all` as a single `kTCCServiceAll` row that iOS 27 does not consult, so the
 * app still prompts, and a revoke of `all` leaves every per-service grant in place. A service the
 * runtime refuses is skipped with a warning, as Android skips a permission it cannot change. Any
 * other failure stops the sequence, and its error carries the services already changed in
 * `details.permissions`. A reset of `all` stays one call: it removes every row.
 */
async function setEveryIosPrivacyService(
  { runSimctl, udid, deviceId }: SimctlSettingRequest,
  action: 'grant' | 'revoke',
  appBundleId: string,
): Promise<Record<string, unknown>> {
  const applied: string[] = [];
  const warnings: string[] = [];
  let lastRefusal: unknown;
  const services = action === 'revoke' ? IOS_ALL_REVOKED_SERVICES : IOS_ALL_GRANTED_SERVICES;
  for (const service of services) {
    try {
      await runSimctl(['privacy', udid, action, service, appBundleId]);
      applied.push(service);
    } catch (error) {
      if (!isIosPrivacyServiceRefusal(error)) throw withAppliedServices(error, applied);
      lastRefusal = error;
      warnings.push(`Skipped ${service}: this iOS runtime does not let simctl privacy change it.`);
    }
  }
  if (applied.length === 0) {
    throw iosPrivacyServiceRefusedError(action, 'all', appBundleId, deviceId, lastRefusal);
  }
  return { permission: 'all', permissions: applied, ...(warnings.length > 0 ? { warnings } : {}) };
}

/** The error that stopped `all` partway, naming the services it had already changed. */
function withAppliedServices(error: unknown, applied: readonly string[]): unknown {
  if (!(error instanceof AppError) || applied.length === 0) return error;
  error.details = { ...error.details, permissions: [...applied] };
  return error;
}

async function setLocation(request: SimctlSettingRequest): Promise<Record<string, unknown> | void> {
  const { runSimctl, udid, state, options } = request;
  if (state.toLowerCase() === 'set') {
    const { latitude, longitude } = requireLocationCoordinates(options);
    await runSimctl(['location', udid, 'set', `${latitude},${longitude}`]);
    return { latitude, longitude };
  }
  const action = parseSettingState(state) ? 'grant' : 'revoke';
  await runSimctl(['privacy', udid, action, 'location', await requireAppBundleId(request)]);
}

async function requireAppBundleId({
  setting,
  appBundleId,
  resolveApp,
}: SimctlSettingRequest): Promise<string> {
  if (appBundleId) return await resolveApp(appBundleId);
  throw new AppError(
    'INVALID_ARGS',
    `${setting} setting requires an active app in session`,
    sessionAppRequiredDetails(),
  );
}

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
 * iOS 27 words the refusal `Failed to create TCC authorization record`.
 */
function isIosPrivacyServiceRefusal(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'COMMAND_FAILED') return false;
  const stderr = String(error.details?.stderr ?? '').toLowerCase();
  return (
    /failed to ((set|grant|revoke|reset) access|create tcc authorization record)/.test(stderr) &&
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
      hint:
        target === 'all'
          ? 'This runtime refused every privacy service. Run `xcrun simctl privacy help` for its documented services, or reset simulator content and settings.'
          : 'Privacy support varies by Xcode runtime: run `xcrun simctl privacy help` for its documented services, or use the `all` target, which applies the action to every service this runtime can change.',
    },
    cause,
  );
}
