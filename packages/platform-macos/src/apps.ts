import type { AppsFilter } from '@agent-device/contracts/device';
import { APP_DEVICE_REASONS, isDeepLinkTarget } from '@agent-device/contracts/command';
import { parseAppearanceAction } from '@agent-device/contracts/settings';
import { isMacOsBundleId, type DeviceInfo } from '@agent-device/kernel/device';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createAppResolutionCache,
  type AppResolutionCacheScope,
} from '@agent-device/provision-kit/app-resolution-cache';
import type {
  MacOsHostProvider,
  MacOsInstalledApp,
} from '@agent-device/contracts/macos-platform-leaf';
import { quitMacOsApp } from './helper.ts';
import { createLocalMacOsHostProvider } from './host-provider.ts';
import type { MacOsToolbox } from './toolbox.ts';

const MACOS_APP_REASONS = {
  // The macOS app was still running after every termination attempt.
  terminationTimeout: { reason: 'MACOS_APP_TERMINATION_TIMEOUT' },
} as const satisfies ReasonTable<'close'>;

const MACOS_ALIASES: Record<string, string> = {
  settings: 'com.apple.systempreferences',
};

// `open` tells a dotted display name such as "Booking.com" from a bundle id by its lowercase
// TLD-style first segment; the shared isMacOsBundleId check stays permissive for everyone else.
const MACOS_BUNDLE_ID_FIRST_SEGMENT = /^[a-z0-9-]+\./;
const MACOS_APP_TERMINATION_POLL_MS = 100;
const MACOS_APP_TERMINATION_MAX_ATTEMPTS = 20;

// macOS currently has no install/uninstall flow; add cache invalidation if that changes.
const MACOS_APP_RESOLUTION_CACHE_SCOPE = {
  platform: 'macos',
  deviceId: 'host',
  variant: 'all',
} satisfies AppResolutionCacheScope;
const macOsAppResolutionCache = createAppResolutionCache<string>();

export async function resolveMacOsApp(box: MacOsToolbox, app: string): Promise<string> {
  const trimmed = app.trim();

  const alias = MACOS_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  if (isMacOsBundleId(trimmed) && MACOS_BUNDLE_ID_FIRST_SEGMENT.test(trimmed)) {
    return trimmed;
  }

  const cached = macOsAppResolutionCache.get(MACOS_APP_RESOLUTION_CACHE_SCOPE, trimmed);
  if (cached) return cached;

  // An installed app matches by name, or by a bundle id spelled in another case: LaunchServices
  // matches bundle ids without regard to case.
  const wanted = trimmed.toLowerCase();
  const apps = await listMacApps(box, 'all');
  const matches = apps.filter(
    (entry) => entry.name.toLowerCase() === wanted || entry.bundleId.toLowerCase() === wanted,
  );
  const match = matches[0];
  if (match !== undefined && matches.length === 1) {
    return macOsAppResolutionCache.set(MACOS_APP_RESOLUTION_CACHE_SCOPE, trimmed, match.bundleId);
  }
  if (matches.length > 1) {
    throw new AppError('INVALID_ARGS', `Multiple apps matched "${app}"`, { matches });
  }

  throw new AppError('APP_NOT_INSTALLED', `No app found matching "${app}"`);
}

/**
 * The open target of an app device (ADR 0035): its own app, which a link alone also opens. Naming
 * another app is refused before anything launches.
 */
export async function resolveMacOsAppDeviceOpenTarget(
  box: MacOsToolbox,
  device: DeviceInfo,
  target: string | undefined,
): Promise<{ appBundleId: string; appName?: string }> {
  const app = requireHostApp(device);
  if (target && !isDeepLinkTarget(target)) {
    assertAppDeviceBundle(device, await resolveMacOsApp(box, target));
  }
  return target ? { appBundleId: app.bundleId, appName: target } : { appBundleId: app.bundleId };
}

/**
 * An app device opens in the background, so the frontmost app and every other session's app stay
 * where they are, and a link alone goes to the device's own app, not the default handler.
 */
export async function openMacOsApp(
  box: MacOsToolbox,
  device: DeviceInfo,
  app: string,
  options?: { appBundleId?: string; url?: string },
): Promise<void> {
  const openOptions = { background: device.hostApp !== undefined };
  const target = app.trim();
  if (device.hostApp && isDeepLinkTarget(target)) {
    await hostProvider(box).openBundle(device.hostApp.bundleId, target, openOptions);
    return;
  }
  const explicitUrl = options?.url?.trim();
  if (explicitUrl) {
    if (!isDeepLinkTarget(explicitUrl)) {
      throw new AppError('INVALID_ARGS', 'open <app> <url> requires a valid URL target');
    }
    const appId = options?.appBundleId ?? (await resolveMacOsApp(box, app));
    assertAppDeviceBundle(device, appId);
    await hostProvider(box).openBundle(appId, explicitUrl, openOptions);
    return;
  }

  if (isDeepLinkTarget(target)) {
    await hostProvider(box).openTarget(target, openOptions);
    return;
  }

  const bundleId = options?.appBundleId ?? (await resolveMacOsApp(box, target));
  assertAppDeviceBundle(device, bundleId);
  await hostProvider(box).openBundle(bundleId, undefined, openOptions);
}

export async function closeMacOsApp(
  box: MacOsToolbox,
  device: DeviceInfo,
  app: string,
  env: Readonly<EnvMap>,
): Promise<void> {
  const bundleId = await resolveMacOsApp(box, app);
  assertAppDeviceBundle(device, bundleId);
  const request = await quitMacOsApp(box, bundleId, env);
  if (!request.running) return;
  if (!request.terminated && !request.forceTerminated) {
    throw new AppError('COMMAND_FAILED', `Failed to close macOS app ${app}`, {
      bundleId,
      running: request.running,
      terminated: request.terminated,
      forceTerminated: request.forceTerminated,
    });
  }
  for (let attempt = 1; attempt < MACOS_APP_TERMINATION_MAX_ATTEMPTS; attempt += 1) {
    await sleep(MACOS_APP_TERMINATION_POLL_MS);
    if (!(await quitMacOsApp(box, bundleId, env)).running) return;
  }
  throw new AppError('COMMAND_FAILED', `Timed out waiting for macOS app ${app} to close`, {
    reason: MACOS_APP_REASONS.terminationTimeout.reason,
    bundleId,
    attempts: MACOS_APP_TERMINATION_MAX_ATTEMPTS,
  });
}

function requireHostApp(device: DeviceInfo): NonNullable<DeviceInfo['hostApp']> {
  if (device.hostApp) return device.hostApp;
  throw new AppError('COMMAND_FAILED', 'Expected a macOS app device.');
}

/** An app device opens and closes its own app only; another app is another device. */
function assertAppDeviceBundle(device: DeviceInfo, bundleId: string): void {
  const app = device.hostApp;
  if (!app || app.bundleId.toLowerCase() === bundleId.toLowerCase()) return;
  throw new AppError(
    'INVALID_ARGS',
    `This session drives ${app.bundleId} as its own device, so it cannot open or close ${bundleId}.`,
    {
      reason: APP_DEVICE_REASONS.scope.reason,
      bundleId: app.bundleId,
      hint: 'Open the other app in a new --session. To open a link in this app, pass the link alone.',
    },
  );
}

export async function readMacOsClipboardText(box: MacOsToolbox): Promise<string> {
  return await hostProvider(box).readClipboard();
}

export async function writeMacOsClipboardText(box: MacOsToolbox, text: string): Promise<void> {
  await hostProvider(box).writeClipboard(text);
}

async function getMacOsDarkModeEnabled(box: MacOsToolbox): Promise<boolean> {
  return await hostProvider(box).readDarkMode();
}

export async function setMacOsAppearance(box: MacOsToolbox, state: string): Promise<void> {
  const action = parseAppearanceAction(state);
  const darkMode = action === 'toggle' ? !(await getMacOsDarkModeEnabled(box)) : action === 'dark';
  await hostProvider(box).setDarkMode(darkMode);
}

export async function listMacApps(
  box: MacOsToolbox,
  filter: AppsFilter,
): Promise<MacOsInstalledApp[]> {
  return await hostProvider(box).listApps(filter);
}

/** The host routes a scoped request supplied, or the local ones this host answers itself. */
function hostProvider(box: MacOsToolbox): MacOsHostProvider {
  return box.tools.host ?? createLocalMacOsHostProvider(box);
}
