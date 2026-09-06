import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { parsePermissionAction, parsePermissionTarget } from '@agent-device/contracts/settings';
import type { SettingOptions } from '@agent-device/contracts/settings';
import { runAndroidAdb } from './adb.ts';
import {
  parseAndroidPackagePermissions,
  readAndroidCurrentUserId,
  readAndroidRuntimePermissionGrants,
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

/**
 * Canonical Maestro/Android names to the `pm` permission ids they fan out to.
 * Mirrors upstream Maestro's `translatePermissionName`; every id is applied
 * with the same `pm grant|revoke` mechanism, so the table needs no per-entry
 * device verification — only the mechanism does, and it is covered on both
 * paths below. `photos` (SDK-dependent probing) and `notifications` (appops)
 * keep their dedicated kinds; `all` resolves against the package instead.
 */
const ANDROID_PERMISSION_TABLE: Readonly<Record<string, readonly string[]>> = {
  bluetooth: ['android.permission.BLUETOOTH_CONNECT', 'android.permission.BLUETOOTH_SCAN'],
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
  phone: ['android.permission.CALL_PHONE', 'android.permission.ANSWER_PHONE_CALLS'],
  sms: [
    'android.permission.READ_SMS',
    'android.permission.RECEIVE_SMS',
    'android.permission.SEND_SMS',
  ],
  storage: [
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.READ_EXTERNAL_STORAGE',
  ],
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
    await grantAndroidPermission(device, appPackage, target, userArgs);
    return;
  }
  // Read before the revoke — afterwards every permission reads as not granted — but resolved
  // after it, because `photos` only learns which permission it revoked by probing the device.
  const grants = await readAndroidRuntimePermissionGrants(device, appPackage, userId);
  const revoked = await revokeAndroidPermission(device, appPackage, action, target, userArgs);
  const states = revoked.map((permission) => grants?.get(permission) ?? 'unknown');
  const priorGrantState: AndroidPriorGrantState = states.includes('granted')
    ? 'granted'
    : states.includes('unknown')
      ? 'unknown'
      : 'not_granted';
  const warnings = revoked.flatMap((permission, index) => {
    const warning = androidRevokedPermissionWarning(appPackage, permission, states[index]!);
    return warning ? [warning] : [];
  });
  return {
    permission: revoked.join(','),
    priorGrantState,
    ...(warnings.length > 0 ? { warnings } : {}),
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
 */
async function setAllAndroidPermissions(
  device: DeviceInfo,
  appPackage: string,
  action: 'grant' | 'deny' | 'reset',
  userId: number,
  userArgs: AndroidUserArgs,
): Promise<Record<string, unknown>> {
  const dump = await runAndroidAdb(device, ['shell', 'dumpsys', 'package', appPackage], {
    allowFailure: true,
  });
  if (dump.exitCode !== 0) {
    throw new AppError(
      'COMMAND_FAILED',
      `Could not read declared permissions for ${appPackage}, so no permission was changed.`,
      { appPackage, stdout: dump.stdout, stderr: dump.stderr, exitCode: dump.exitCode },
    );
  }
  const { requested, grants: revokedGrants } = parseAndroidPackagePermissions(dump.stdout, userId);
  if (requested === undefined) {
    throw new AppError(
      'COMMAND_FAILED',
      `Could not find declared permissions for ${appPackage}, so no permission was changed.`,
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
    applied,
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

async function applyAllNotificationsUnit(ctx: AllUnitContext): Promise<void> {
  const { device, appPackage, action, userArgs, grants, applied, warnings } = ctx;
  await setAndroidNotificationPermission(
    device,
    appPackage,
    action,
    { appOps: 'POST_NOTIFICATION', permission: 'android.permission.POST_NOTIFICATIONS' },
    userArgs,
  );
  applied.push('android.permission.POST_NOTIFICATIONS');
  warnIfRevoked(warnings, grants, appPackage, 'android.permission.POST_NOTIFICATIONS');
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
  const attempt = await tryPmUnit(
    device,
    action === 'grant' ? 'grant' : 'revoke',
    userArgs,
    appPackage,
    permission,
  );
  if (!attempt.ok) {
    warnings.push(`Skipped ${permission} for ${appPackage}: ${attempt.reason}`);
    return;
  }
  await finishAllUnit(ctx, permission);
}

/** Record a landed mutation: reset its flags when asked, then warn if it may have killed the app. */
async function finishAllUnit(ctx: AllUnitContext, permission: string): Promise<void> {
  const { device, appPackage, action, userArgs, grants, applied, warnings } = ctx;
  applied.push(permission);
  if (action === 'reset')
    await clearAndroidPermissionFlags(device, appPackage, permission, userArgs);
  if (action !== 'grant') warnIfRevoked(warnings, grants, appPackage, permission);
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

async function tryPmUnit(
  device: DeviceInfo,
  pmAction: 'grant' | 'revoke',
  userArgs: AndroidUserArgs,
  appPackage: string,
  permission: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await runAndroidAdb(
    device,
    ['shell', 'pm', pmAction, ...userArgs, appPackage, permission],
    { allowFailure: true },
  );
  if (result.exitCode === 0) return { ok: true };
  return { ok: false, reason: firstStderrLine(result.stderr) };
}

async function tryPhotosUnit(
  device: DeviceInfo,
  appPackage: string,
  pmAction: 'grant' | 'revoke',
  userArgs: AndroidUserArgs,
): Promise<string | undefined> {
  try {
    return await setAndroidPhotoPermission(device, appPackage, pmAction, userArgs);
  } catch {
    return undefined;
  }
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
  userArgs: AndroidUserArgs,
): Promise<void> {
  if (target.kind === 'notifications') {
    await setAndroidNotificationPermission(device, appPackage, 'grant', target, userArgs);
  } else if (target.kind === 'photos') {
    await setAndroidPhotoPermission(device, appPackage, 'grant', userArgs);
  } else if (target.kind === 'pm') {
    for (const value of target.values) {
      await runAndroidAdb(device, ['shell', 'pm', 'grant', ...userArgs, appPackage, value]);
    }
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
    for (const value of target.values) {
      await runAndroidAdb(device, ['shell', 'pm', 'revoke', ...userArgs, appPackage, value]);
    }
    if (action === 'reset') {
      for (const value of target.values) {
        await clearAndroidPermissionFlags(device, appPackage, value, userArgs);
      }
    }
    return [...target.values];
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
  | { kind: 'pm'; values: readonly string[] }
  | { kind: 'photos' }
  | { kind: 'notifications'; appOps: string; permission: string }
  | { kind: 'all' } {
  const normalized = parsePermissionTarget(permissionTarget);
  if (normalized === 'all') {
    if (permissionMode?.trim()) {
      throw new AppError(
        'INVALID_ARGS',
        `Permission mode is only supported for photos. Received: ${permissionMode}.`,
      );
    }
    return { kind: 'all' };
  }
  if (permissionMode?.trim()) {
    throw new AppError(
      'INVALID_ARGS',
      `Permission mode is only supported for photos. Received: ${permissionMode}.`,
    );
  }
  if (normalized === 'photos') return { kind: 'photos' };
  if (normalized === 'notifications') {
    return {
      kind: 'notifications',
      appOps: 'POST_NOTIFICATION',
      permission: 'android.permission.POST_NOTIFICATIONS',
    };
  }
  const values = ANDROID_PERMISSION_TABLE[normalized];
  if (values) return { kind: 'pm', values };
  throw new AppError(
    'INVALID_ARGS',
    `Unsupported permission target on Android: ${permissionTarget}. Use all|bluetooth|calendar|camera|contacts|location|media-library|microphone|notifications|phone|photos|sms|storage.`,
    { hint: 'Android custom permission ids are attempted through all, not individually.' },
  );
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

  const failures: Array<{ permission: string; stderr: string; exitCode: number }> = [];
  for (const permission of candidates) {
    const result = await runAndroidAdb(
      device,
      ['shell', 'pm', pmAction, ...userArgs, appPackage, permission],
      { allowFailure: true },
    );
    if (result.exitCode === 0) return permission;
    failures.push({ permission, stderr: result.stderr, exitCode: result.exitCode });
  }

  throw new AppError('COMMAND_FAILED', `Failed to ${pmAction} Android photos permission`, {
    appPackage,
    sdkInt,
    attempts: failures,
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
    await runAndroidAdb(
      device,
      ['shell', 'pm', 'grant', ...userArgs, appPackage, target.permission],
      { allowFailure: true },
    );
  } else {
    await runAndroidAdb(
      device,
      ['shell', 'pm', 'revoke', ...userArgs, appPackage, target.permission],
      { allowFailure: true },
    );
    if (action === 'reset') {
      await clearAndroidPermissionFlags(device, appPackage, target.permission, userArgs);
    }
  }
  await runAndroidAdb(device, [
    'shell',
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
    await runAndroidAdb(
      device,
      ['shell', 'pm', 'clear-permission-flags', ...userArgs, appPackage, permission, flag],
      { allowFailure: true },
    );
  }
}

async function getAndroidSdkInt(device: DeviceInfo): Promise<number | null> {
  const result = await runAndroidAdb(device, ['shell', 'getprop', 'ro.build.version.sdk'], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) return null;
  const value = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}
