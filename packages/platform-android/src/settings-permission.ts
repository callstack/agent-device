import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { parsePermissionAction, parsePermissionTarget } from '@agent-device/contracts/settings';
import type { SettingOptions } from '@agent-device/contracts/settings';
import { runAndroidAdb } from './adb.ts';
import {
  readAndroidCurrentUserId,
  readAndroidRuntimePermissionGrants,
  type AndroidPriorGrantState,
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
  if (action === 'grant') {
    await grantAndroidPermission(device, appPackage, target, userArgs);
    return;
  }
  // Read before the revoke — afterwards every permission reads as not granted — but resolved
  // after it, because `photos` only learns which permission it revoked by probing the device.
  const grants = await readAndroidRuntimePermissionGrants(device, appPackage, userId);
  const permission = await revokeAndroidPermission(device, appPackage, action, target, userArgs);
  const priorGrantState: AndroidPriorGrantState = grants?.get(permission) ?? 'unknown';
  const warning = androidRevokedPermissionWarning(appPackage, permission, priorGrantState);
  return {
    permission,
    priorGrantState,
    ...(warning ? { warnings: [warning] } : {}),
  };
}

async function grantAndroidPermission(
  device: DeviceInfo,
  appPackage: string,
  target: AndroidPermissionTarget,
  userArgs: AndroidUserArgs,
): Promise<void> {
  if (target.kind === 'notifications') {
    await setAndroidNotificationPermission(device, appPackage, 'grant', target, userArgs);
  } else if (target.type === 'photos') {
    await setAndroidPhotoPermission(device, appPackage, 'grant', userArgs);
  } else {
    await runAndroidAdb(device, ['shell', 'pm', 'grant', ...userArgs, appPackage, target.value]);
  }
}

/** Revokes (and for `reset`, clears the flags of) the target; returns the permission revoked. */
async function revokeAndroidPermission(
  device: DeviceInfo,
  appPackage: string,
  action: 'deny' | 'reset',
  target: AndroidPermissionTarget,
  userArgs: AndroidUserArgs,
): Promise<string> {
  if (target.kind === 'notifications') {
    await setAndroidNotificationPermission(device, appPackage, action, target, userArgs);
    return target.permission;
  }
  let permission: string;
  if (target.type === 'photos') {
    permission = await setAndroidPhotoPermission(device, appPackage, 'revoke', userArgs);
  } else {
    permission = target.value;
    await runAndroidAdb(device, ['shell', 'pm', 'revoke', ...userArgs, appPackage, permission]);
  }
  if (action === 'reset') {
    await clearAndroidPermissionFlags(device, appPackage, permission, userArgs);
  }
  return permission;
}

function parseAndroidPermissionTarget(
  permissionTarget: string | undefined,
  permissionMode: string | undefined,
):
  | { kind: 'pm'; value: string; type: 'camera' | 'microphone' | 'photos' | 'contacts' }
  | { kind: 'notifications'; appOps: string; permission: string } {
  const normalized = parsePermissionTarget(permissionTarget);
  if (permissionMode?.trim()) {
    throw new AppError(
      'INVALID_ARGS',
      `Permission mode is only supported for photos. Received: ${permissionMode}.`,
    );
  }
  if (normalized === 'camera')
    return { kind: 'pm', value: 'android.permission.CAMERA', type: 'camera' };
  if (normalized === 'microphone') {
    return { kind: 'pm', value: 'android.permission.RECORD_AUDIO', type: 'microphone' };
  }
  if (normalized === 'photos') {
    return { kind: 'pm', value: 'android.permission.READ_MEDIA_IMAGES', type: 'photos' };
  }
  if (normalized === 'contacts') {
    return { kind: 'pm', value: 'android.permission.READ_CONTACTS', type: 'contacts' };
  }
  if (normalized === 'notifications') {
    return {
      kind: 'notifications',
      appOps: 'POST_NOTIFICATION',
      permission: 'android.permission.POST_NOTIFICATIONS',
    };
  }
  throw new AppError(
    'INVALID_ARGS',
    `Unsupported permission target on Android: ${permissionTarget}. Use camera|microphone|photos|contacts|notifications.`,
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
