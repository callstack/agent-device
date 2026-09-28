import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  type MobilePermissionTarget,
  parsePermissionAction,
  parsePermissionTarget,
  type SettingOptions,
} from '@agent-device/contracts/settings';
import { runAndroidShell } from './adb.ts';
import { androidAdbResultError } from './adb-failure.ts';
import {
  readAndroidCurrentUserId,
  readAndroidPackagePermissions,
  type AndroidPriorGrantState,
  type AndroidRuntimePermissionGrants,
} from './permission-grant-state.ts';

/**
 * Android kills the app's process whenever a runtime permission it currently holds is
 * revoked (`pm revoke` after a grant, foreground or background), so a `deny`/`reset` that
 * follows a grant leaves the session pointing at a dead app and the next selector fails
 * against the launcher (#1796). Revoking a permission the app does not hold is harmless.
 *
 * Process death itself is NOT observed (that would be option (b) in the issue) and the prior
 * state cannot prove the app was running, so the consequence stays conditional. When the state
 * could not be read, the same guidance is given without claiming what the state was: silence
 * there would assert "your app is untouched" on no evidence.
 */
export function androidRevokedPermissionWarning(
  appPackage: string,
  permission: string,
  priorGrantState: AndroidPriorGrantState,
): string | undefined {
  if (priorGrantState === 'not_granted') return undefined;
  const preamble =
    priorGrantState === 'granted'
      ? `${permission} was granted before this revoke, and Android kills an app when a granted permission is revoked: if ${appPackage} was running it is no longer.`
      : `Whether ${permission} was granted before this revoke could not be read (adb did not report the acting user's runtime permission state), and Android kills an app when a granted permission is revoked: ${appPackage} may no longer be running.`;
  return `${preamble} Relaunch it with open ${appPackage} --relaunch before the next interaction.`;
}

type AndroidPermissionTarget = ReturnType<typeof parseAndroidPermissionTarget>;

/** The targets Android serves, in the order its refusal lists them. */
const ANDROID_PERMISSION_TARGETS = [
  'all',
  'camera',
  'microphone',
  'photos',
  'contacts',
  'notifications',
  'calendar',
  'location',
  'media-library',
] as const satisfies readonly MobilePermissionTarget[];

type AndroidPermissionName = (typeof ANDROID_PERMISSION_TARGETS)[number];

/**
 * The `pm` permission ids each plain target fans out to. `photos` (SDK-dependent probing) and
 * `notifications` (appops) keep their dedicated kinds, and `all` resolves against the package
 * instead. `contacts`/`location`/`calendar` fan out to several ids; the named path intersects
 * those with the package's declared permissions (like `all` does) so an app declaring only one
 * id still succeeds.
 */
const ANDROID_PERMISSION_TABLE: Record<
  Exclude<AndroidPermissionName, 'all' | 'photos' | 'notifications'>,
  readonly string[]
> = {
  calendar: ['android.permission.WRITE_CALENDAR', 'android.permission.READ_CALENDAR'],
  camera: ['android.permission.CAMERA'],
  contacts: ['android.permission.READ_CONTACTS', 'android.permission.WRITE_CONTACTS'],
  location: [
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
  ],
  'media-library': [
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.READ_MEDIA_AUDIO',
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_MEDIA_VIDEO',
  ],
  microphone: ['android.permission.RECORD_AUDIO'],
};

/**
 * `--user <id>` for every permission mutation, resolved once so the state read and the mutation
 * cannot address different users. Never empty: a permission mutation that cannot name its user
 * is refused rather than issued (see `requireAndroidPermissionUser`).
 */
type AndroidUserArgs = readonly string[];

/**
 * The user a permission mutation will act on, or a refusal.
 *
 * `pm` and `appops` default to `UserHandle.USER_SYSTEM`, so an unscoped mutation on a device
 * whose foreground user is nonzero edits user 0 and leaves the running app untouched — the
 * defect #1796 is about. Issuing the bare command as a fallback would reintroduce it on exactly
 * the path where we already know we are guessing, so the command refuses instead: no permission
 * state is changed when we cannot name whose state it is.
 */
async function requireAndroidPermissionUser(device: DeviceInfo): Promise<number> {
  const userId = await readAndroidCurrentUserId(device);
  if (userId !== undefined) return userId;
  throw new AppError(
    'COMMAND_FAILED',
    'Could not determine which Android user the session runs as, so no permission was changed.',
    {
      deviceId: device.id,
      hint: `Check adb -s ${device.id} shell am get-current-user — if the device is still booting, retry once it reports a user. agent-device refuses to change permissions it cannot scope, because pm would silently apply them to user 0.`,
    },
  );
}

export async function setAndroidPermission(
  device: DeviceInfo,
  appPackage: string,
  state: string,
  options: SettingOptions | undefined,
): Promise<Record<string, unknown> | void> {
  const action = parsePermissionAction(state);
  const target = parseAndroidPermissionTarget(options?.permissionTarget, options?.permissionMode);
  const userId = await requireAndroidPermissionUser(device);
  const userArgs: AndroidUserArgs = ['--user', String(userId)];
  if (target.kind === 'all') {
    return await setAllAndroidPermissions(device, appPackage, action, userId, userArgs);
  }
  if (action === 'grant') {
    const granted = await grantAndroidPermission(device, appPackage, target, userId, userArgs);
    return androidPermissionResponse(androidPermissionName(target), granted);
  }
  // Named `pm` targets resolve their ids and prior grants from one `dumpsys`
  // read before mutating, so a READ-only contacts app revokes only READ.
  if (target.kind === 'pm') {
    return await revokeNamedPmTarget(device, appPackage, action, target, userId, userArgs);
  }
  // Read before the revoke — afterwards every permission reads as not granted — but resolved
  // after it, because `photos` only learns which permission it revoked by probing the device.
  const { grants } = await readAndroidPackagePermissions(device, appPackage, userId);
  const revoked = await revokeAndroidPermission(device, appPackage, action, target, userArgs);
  const states = revoked.map((permission) => grants?.get(permission) ?? 'unknown');
  const { priorGrantState, warnings } = summarizeRevokedPermissions(appPackage, revoked, states);
  return androidPermissionResponse(target.kind, revoked, { priorGrantState, warnings });
}

function androidPermissionName(target: AndroidPermissionTarget): string {
  return target.kind === 'pm' ? target.name : target.kind;
}

/** The one response shape for a named permission change: the requested target and the ids it changed. */
function androidPermissionResponse(
  permission: string,
  permissions: readonly string[],
  revoke?: { priorGrantState: AndroidPriorGrantState; warnings: readonly string[] },
): Record<string, unknown> {
  return {
    permission,
    permissions: [...permissions],
    ...(revoke
      ? {
          priorGrantState: revoke.priorGrantState,
          ...(revoke.warnings.length > 0 ? { warnings: revoke.warnings } : {}),
        }
      : {}),
  };
}

/**
 * `all`: every permission the package declares, resolved from one `dumpsys
 * package` read before anything is mutated. Declared-but-not-changeable ids
 * (install permissions like INTERNET, special ids like MANAGE_EXTERNAL_STORAGE,
 * custom ids the runtime rejects) are skipped with a reason instead of
 * stopping the sequence — while an explicit target for the same id still
 * fails loudly. Anything the dump does not list is never attempted, which is
 * what keeps `pm` from throwing "has not requested permission" partway.
 * Operational failures (offline device, dropped transport) abort the fan-out
 * instead of becoming skips, so launchApp cannot continue half-applied.
 */
async function setAllAndroidPermissions(
  device: DeviceInfo,
  appPackage: string,
  action: 'grant' | 'deny' | 'reset',
  userId: number,
  userArgs: AndroidUserArgs,
): Promise<Record<string, unknown>> {
  const { requested, grants: revokedGrants } = await readAndroidPackagePermissions(
    device,
    appPackage,
    userId,
  );
  if (requested === undefined) {
    throw new AppError(
      'COMMAND_FAILED',
      `Could not read declared permissions for ${appPackage}, so no permission was changed.`,
      { appPackage },
    );
  }
  const grants = action === 'grant' ? undefined : revokedGrants;
  const applied: string[] = [];
  const warnings: string[] = [];
  for (const unit of allPermissionUnits(requested)) {
    await applyAllPermissionUnit(
      { device, appPackage, action, userArgs, grants, applied, warnings },
      unit,
    );
  }
  return {
    permission: 'all',
    permissions: applied,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

type AllUnitContext = {
  device: DeviceInfo;
  appPackage: string;
  action: 'grant' | 'deny' | 'reset';
  userArgs: AndroidUserArgs;
  grants: AndroidRuntimePermissionGrants | undefined;
  applied: string[];
  warnings: string[];
};

/** One declared-permission unit: strict appops for notifications, best-effort pm otherwise. */
async function applyAllPermissionUnit(ctx: AllUnitContext, unit: AllPermissionUnit): Promise<void> {
  if (unit.kind === 'notification') return await applyAllNotificationsUnit(ctx);
  if (unit.kind === 'photos') return await applyAllPhotosUnit(ctx);
  return await applyAllPmUnit(ctx, unit.value);
}

// Notifications self-clears its reset flags inside `setAndroidNotificationPermission`, so it
// records the applied id directly instead of going through `finishAllUnit` (which would clear
// them a second time).
async function applyAllNotificationsUnit(ctx: AllUnitContext): Promise<void> {
  const { device, appPackage, action, userArgs } = ctx;
  await setAndroidNotificationPermission(
    device,
    appPackage,
    action,
    { appOps: 'POST_NOTIFICATION', permission: 'android.permission.POST_NOTIFICATIONS' },
    userArgs,
  );
  recordAppliedPermission(ctx, 'android.permission.POST_NOTIFICATIONS');
}

async function applyAllPhotosUnit(ctx: AllUnitContext): Promise<void> {
  const { device, appPackage, action, userArgs, warnings } = ctx;
  const resolved = await tryPhotosUnit(
    device,
    appPackage,
    action === 'grant' ? 'grant' : 'revoke',
    userArgs,
  );
  if (resolved === undefined) {
    warnings.push(
      `Skipped Android photos permission for ${appPackage}: device refused both media candidates.`,
    );
    return;
  }
  await finishAllUnit(ctx, resolved);
}

async function applyAllPmUnit(ctx: AllUnitContext, permission: string): Promise<void> {
  const { device, appPackage, action, userArgs, warnings } = ctx;
  const outcome = await tryPmUnit(
    device,
    action === 'grant' ? 'grant' : 'revoke',
    userArgs,
    appPackage,
    permission,
  );
  if (outcome.kind === 'skipped') {
    warnings.push(`Skipped ${permission} for ${appPackage}: ${outcome.detail}`);
    return;
  }
  await finishAllUnit(ctx, permission);
}

/** The shared `applied`/relaunch-warning accounting every unit records once it lands. */
function recordAppliedPermission(ctx: AllUnitContext, permission: string): void {
  const { appPackage, action, grants, applied, warnings } = ctx;
  applied.push(permission);
  if (action !== 'grant') warnIfRevoked(warnings, grants, appPackage, permission);
}

/** Record a landed mutation, then reset its flags when asked. */
async function finishAllUnit(ctx: AllUnitContext, permission: string): Promise<void> {
  recordAppliedPermission(ctx, permission);
  if (ctx.action === 'reset') {
    await clearAndroidPermissionFlags(ctx.device, ctx.appPackage, permission, ctx.userArgs);
  }
}

type AllPermissionUnit =
  | { kind: 'photos' }
  | { kind: 'notification' }
  | { kind: 'pm'; value: string };

/** Collapse declared ids into mutation units: one photos probe, one appops path, direct pm otherwise. */
function allPermissionUnits(requested: readonly string[]): AllPermissionUnit[] {
  const units: AllPermissionUnit[] = [];
  let photosQueued = false;
  for (const id of requested) {
    if (id === 'android.permission.POST_NOTIFICATIONS') units.push({ kind: 'notification' });
    else if (
      id === 'android.permission.READ_MEDIA_IMAGES' ||
      id === 'android.permission.READ_EXTERNAL_STORAGE'
    ) {
      if (!photosQueued) {
        photosQueued = true;
        units.push({ kind: 'photos' });
      }
    } else units.push({ kind: 'pm', value: id });
  }
  return units;
}

function warnIfRevoked(
  warnings: string[],
  grants: AndroidRuntimePermissionGrants | undefined,
  appPackage: string,
  permission: string,
): void {
  const warning = androidRevokedPermissionWarning(
    appPackage,
    permission,
    grants?.get(permission) ?? 'unknown',
  );
  if (warning) warnings.push(warning);
}

/**
 * Reasons `pm` gives for refusing an `all`-fanout mutation, established once at the pm
 * boundary: an install permission `pm` cannot touch, an id the package never requested, a
 * name the runtime does not know as a runtime permission, an id managed by a role
 * (`WRITE_SETTINGS` on API 36 reports "managed by role"), or an unknown id. Anything else
 * (offline device, dropped transport, denied op) does not classify and must abort the
 * fan-out rather than let launchApp continue with half-applied permissions.
 */
type AndroidPmSkipReason =
  | 'not-changeable'
  | 'not-requested'
  | 'not-runtime-permission'
  | 'unknown-permission'
  | 'role-managed';

const ANDROID_PM_SKIP_PATTERNS: ReadonlyArray<readonly [RegExp, AndroidPmSkipReason]> = [
  [/not a changeable permission/, 'not-changeable'],
  [/has not requested permission/, 'not-requested'],
  [/is not a runtime permission/, 'not-runtime-permission'],
  [/unknown permission/, 'unknown-permission'],
  [/managed by role/, 'role-managed'],
];

/**
 * The one place `pm` stderr is read to decide whether a refusal is skippable. Every other
 * function in this file consumes the typed reason this returns instead of re-matching stderr.
 */
function classifyAndroidPmSkip(stderr: string): AndroidPmSkipReason | undefined {
  const text = stderr.toLowerCase();
  return ANDROID_PM_SKIP_PATTERNS.find(([pattern]) => pattern.test(text))?.[1];
}

type AndroidPmUnitOutcome =
  | { kind: 'applied' }
  | { kind: 'skipped'; reason: AndroidPmSkipReason; detail: string };

/** One candidate `pm` refused while resolving the photos permission, classified once. */
type AndroidPmSkipAttempt = {
  permission: string;
  reason: AndroidPmSkipReason | undefined;
  detail: string;
};

async function tryPmUnit(
  device: DeviceInfo,
  pmAction: 'grant' | 'revoke',
  userArgs: AndroidUserArgs,
  appPackage: string,
  permission: string,
): Promise<AndroidPmUnitOutcome> {
  const result = await runAndroidShell(
    device,
    ['pm', pmAction, ...userArgs, appPackage, permission],
    { allowFailure: true },
  );
  if (result.exitCode === 0) return { kind: 'applied' };
  const reason = classifyAndroidPmSkip(result.stderr);
  if (reason) return { kind: 'skipped', reason, detail: firstStderrLine(result.stderr) };
  throw androidAdbResultError(
    `Failed to ${pmAction} Android permission ${permission} for ${appPackage}`,
    result,
    { appPackage, permission },
  );
}

async function tryPhotosUnit(
  device: DeviceInfo,
  appPackage: string,
  pmAction: 'grant' | 'revoke',
  userArgs: AndroidUserArgs,
): Promise<string | undefined> {
  try {
    return await setAndroidPhotoPermission(device, appPackage, pmAction, userArgs);
  } catch (error) {
    if (isAndroidPhotosSkipAttempts(error)) return undefined;
    throw error;
  }
}

/**
 * A photos probe failure is skippable only when the pm boundary already classified every
 * candidate it tried; this reads the typed `attempts` `setAndroidPhotoPermission` recorded
 * instead of re-matching stderr.
 */
function isAndroidPhotosSkipAttempts(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'COMMAND_FAILED') return false;
  const attempts = error.details?.attempts;
  return (
    isAndroidPmSkipAttemptList(attempts) &&
    attempts.length > 0 &&
    attempts.every((attempt) => attempt.reason !== undefined)
  );
}

function isAndroidPmSkipAttemptList(value: unknown): value is readonly AndroidPmSkipAttempt[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { permission?: unknown }).permission === 'string' &&
        typeof (item as { detail?: unknown }).detail === 'string',
    )
  );
}

function firstStderrLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const first = lines[0] ?? 'unknown device error';
  // adb wraps the cause onto the next line ("Exception occurred ...:\njava.lang...").
  const reason = first.endsWith(':') && lines[1] ? `${first} ${lines[1]}` : first;
  return reason.slice(0, 200);
}

async function grantAndroidPermission(
  device: DeviceInfo,
  appPackage: string,
  target: AndroidPermissionTarget,
  userId: number,
  userArgs: AndroidUserArgs,
): Promise<string[]> {
  if (target.kind === 'notifications') {
    await setAndroidNotificationPermission(device, appPackage, 'grant', target, userArgs);
    return [target.permission];
  } else if (target.kind === 'photos') {
    return [await setAndroidPhotoPermission(device, appPackage, 'grant', userArgs)];
  } else if (target.kind === 'pm') {
    const granted = [...(await resolveNamedPmIds(device, appPackage, target.values, userId))];
    for (const value of granted) {
      await runAndroidShell(device, ['pm', 'grant', ...userArgs, appPackage, value]);
    }
    return granted;
  } else if (target.kind === 'all') {
    throw new Error('Unhandled Android permission target: all is resolved by the caller.');
  } else {
    const exhaustive: never = target;
    throw new Error(`Unhandled Android permission target: ${JSON.stringify(exhaustive)}`);
  }
}

/** Revokes (and for `reset`, clears the flags of) the target; returns the permissions revoked. */
async function revokeAndroidPermission(
  device: DeviceInfo,
  appPackage: string,
  action: 'deny' | 'reset',
  target: AndroidPermissionTarget,
  userArgs: AndroidUserArgs,
): Promise<string[]> {
  if (target.kind === 'notifications') {
    await setAndroidNotificationPermission(device, appPackage, action, target, userArgs);
    return [target.permission];
  }
  if (target.kind === 'photos') {
    const resolved = await setAndroidPhotoPermission(device, appPackage, 'revoke', userArgs);
    if (action === 'reset') {
      await clearAndroidPermissionFlags(device, appPackage, resolved, userArgs);
    }
    return [resolved];
  }
  if (target.kind === 'pm') {
    throw new Error('Unhandled Android permission target: pm is resolved by the caller.');
  }
  if (target.kind === 'all') {
    throw new Error('Unhandled Android permission target: all is resolved by the caller.');
  }
  const exhaustive: never = target;
  throw new Error(`Unhandled Android permission target: ${JSON.stringify(exhaustive)}`);
}

function parseAndroidPermissionTarget(
  permissionTarget: string | undefined,
  permissionMode: string | undefined,
):
  | {
      kind: 'pm';
      name: Exclude<AndroidPermissionName, 'all' | 'photos' | 'notifications'>;
      values: readonly string[];
    }
  | { kind: 'photos' }
  | { kind: 'notifications'; appOps: string; permission: string }
  | { kind: 'all' } {
  const normalized = parsePermissionTarget(permissionTarget);
  if (permissionMode?.trim()) {
    throw new AppError(
      'INVALID_ARGS',
      `Android does not support permission modes. Received: ${permissionMode}.`,
    );
  }
  if (normalized === 'all') return { kind: 'all' };
  if (normalized === 'photos') return { kind: 'photos' };
  if (normalized === 'notifications') {
    return {
      kind: 'notifications',
      appOps: 'POST_NOTIFICATION',
      permission: 'android.permission.POST_NOTIFICATIONS',
    };
  }
  const values =
    normalized in ANDROID_PERMISSION_TABLE
      ? ANDROID_PERMISSION_TABLE[normalized as keyof typeof ANDROID_PERMISSION_TABLE]
      : undefined;
  if (values)
    return { kind: 'pm', name: normalized as keyof typeof ANDROID_PERMISSION_TABLE, values };
  throw new AppError(
    'INVALID_ARGS',
    `Unsupported permission target on Android: ${permissionTarget}. Use ${ANDROID_PERMISSION_TARGETS.join('|')}.`,
    { hint: 'Android custom permission ids are attempted through all, not individually.' },
  );
}

/**
 * Intersect a named multi-id target with the package's declared permissions —
 * the same read `all` uses. `pm` throws "has not requested permission"
 * for any id the app does not declare, so attempting every id strictly fails
 * `contacts` on a READ-only app (which worked before the fan-out) and
 * `location: allow` on coarse-only apps. Only declared ids are attempted; an
 * explicit target declaring none of its ids fails loudly instead of
 * silently succeeding. An unreadable dump falls back to the strict table so a
 * missing `requested permissions:` section does not newly block single-id
 * targets the device would still serve.
 */
async function resolveNamedPmIds(
  device: DeviceInfo,
  appPackage: string,
  values: readonly string[],
  userId: number,
): Promise<readonly string[]> {
  const { requested } = await readAndroidPackagePermissions(device, appPackage, userId);
  return filterNamedPmIds(requested, values, appPackage);
}

function filterNamedPmIds(
  requested: string[] | undefined,
  values: readonly string[],
  appPackage: string,
): readonly string[] {
  if (requested === undefined) return values;
  const declared = values.filter((value) => requested.includes(value));
  if (declared.length === 0) {
    throw new AppError(
      'COMMAND_FAILED',
      `Package ${appPackage} has not requested permission ${values.join(', ')}, so no permission was changed.`,
      { appPackage, permissions: values },
    );
  }
  return declared;
}

/** Revoke a named `pm` target from one `dumpsys` read: declared ids plus prior grants together. */
async function revokeNamedPmTarget(
  device: DeviceInfo,
  appPackage: string,
  action: 'deny' | 'reset',
  target: {
    kind: 'pm';
    name: Exclude<AndroidPermissionName, 'all' | 'photos' | 'notifications'>;
    values: readonly string[];
  },
  userId: number,
  userArgs: AndroidUserArgs,
): Promise<Record<string, unknown>> {
  const { requested, grants } = await readAndroidPackagePermissions(device, appPackage, userId);
  const values = filterNamedPmIds(requested, target.values, appPackage);
  await applyPmRevoke(device, appPackage, values, action, userArgs);
  const states = values.map((permission) => grants?.get(permission) ?? 'unknown');
  const { priorGrantState, warnings } = summarizeRevokedPermissions(appPackage, values, states);
  return androidPermissionResponse(target.name, values, { priorGrantState, warnings });
}

/** The `pm revoke` (plus flag-clearing for `reset`) half of a named-target revoke. */
async function applyPmRevoke(
  device: DeviceInfo,
  appPackage: string,
  values: readonly string[],
  action: 'deny' | 'reset',
  userArgs: AndroidUserArgs,
): Promise<void> {
  for (const value of values) {
    await runAndroidShell(device, ['pm', 'revoke', ...userArgs, appPackage, value]);
  }
  if (action === 'reset') {
    for (const value of values) {
      await clearAndroidPermissionFlags(device, appPackage, value, userArgs);
    }
  }
}

/** One shared summary for every revoke path: the prior-grant verdict plus relaunch warnings. */
function summarizeRevokedPermissions(
  appPackage: string,
  permissions: readonly string[],
  states: readonly AndroidPriorGrantState[],
): { priorGrantState: AndroidPriorGrantState; warnings: string[] } {
  const priorGrantState: AndroidPriorGrantState = states.includes('granted')
    ? 'granted'
    : states.includes('unknown')
      ? 'unknown'
      : 'not_granted';
  const warnings = permissions.flatMap((permission, index) => {
    const warning = androidRevokedPermissionWarning(appPackage, permission, states[index]!);
    return warning ? [warning] : [];
  });
  return { priorGrantState, warnings };
}

async function setAndroidPhotoPermission(
  device: DeviceInfo,
  appPackage: string,
  pmAction: 'grant' | 'revoke',
  userArgs: AndroidUserArgs,
): Promise<string> {
  const sdkInt = await getAndroidSdkInt(device);
  const candidates =
    sdkInt !== null && sdkInt >= 33
      ? ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_EXTERNAL_STORAGE']
      : ['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.READ_MEDIA_IMAGES'];

  const attempts: AndroidPmSkipAttempt[] = [];
  for (const permission of candidates) {
    const result = await runAndroidShell(
      device,
      ['pm', pmAction, ...userArgs, appPackage, permission],
      { allowFailure: true },
    );
    if (result.exitCode === 0) return permission;
    attempts.push({
      permission,
      reason: classifyAndroidPmSkip(result.stderr),
      detail: firstStderrLine(result.stderr),
    });
  }

  throw new AppError('COMMAND_FAILED', `Failed to ${pmAction} Android photos permission`, {
    appPackage,
    sdkInt,
    attempts,
  });
}

async function setAndroidNotificationPermission(
  device: DeviceInfo,
  appPackage: string,
  action: 'grant' | 'deny' | 'reset',
  target: { appOps: string; permission: string },
  userArgs: AndroidUserArgs,
): Promise<void> {
  const appOpsMode = action === 'grant' ? 'allow' : action === 'deny' ? 'deny' : 'default';
  if (action === 'grant') {
    await runAndroidShell(device, ['pm', 'grant', ...userArgs, appPackage, target.permission], {
      allowFailure: true,
    });
  } else {
    await runAndroidShell(device, ['pm', 'revoke', ...userArgs, appPackage, target.permission], {
      allowFailure: true,
    });
    if (action === 'reset') {
      await clearAndroidPermissionFlags(device, appPackage, target.permission, userArgs);
    }
  }
  await runAndroidShell(device, [
    'appops',
    'set',
    ...userArgs,
    appPackage,
    target.appOps,
    appOpsMode,
  ]);
}

async function clearAndroidPermissionFlags(
  device: DeviceInfo,
  appPackage: string,
  permission: string,
  userArgs: AndroidUserArgs,
): Promise<void> {
  for (const flag of ['user-set', 'user-fixed']) {
    await runAndroidShell(
      device,
      ['pm', 'clear-permission-flags', ...userArgs, appPackage, permission, flag],
      { allowFailure: true },
    );
  }
}

async function getAndroidSdkInt(device: DeviceInfo): Promise<number | null> {
  const result = await runAndroidShell(device, ['getprop', 'ro.build.version.sdk'], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) return null;
  const value = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}
