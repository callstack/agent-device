import type { AppsFilter } from '@agent-device/contracts/device';
import { isDeepLinkTarget } from '@agent-device/contracts/command';
import { parseAppearanceAction } from '@agent-device/contracts/settings';
import { isMacOsBundleId, type DeviceInfo } from '@agent-device/kernel/device';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { AppError } from '@agent-device/kernel/errors';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createAppResolutionCache,
  type AppResolutionCacheScope,
} from '@agent-device/provision-kit/app-resolution-cache';
import { quitMacOsApp } from './helper.ts';
import { resolveAppleToolProvider, type AppleMacOsHostProvider } from '../../core/tool-provider.ts';
import type { IosAppInfo } from '../../core/app-info.ts';

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

export async function resolveMacOsApp(app: string): Promise<string> {
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
  const apps = await listMacApps('all');
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
  device: DeviceInfo,
  target: string | undefined,
): Promise<{ appBundleId: string; appName?: string }> {
  const app = requireHostApp(device);
  if (target && !isDeepLinkTarget(target)) {
    assertAppDeviceBundle(device, await resolveMacOsApp(target));
  }
  return target ? { appBundleId: app.bundleId, appName: target } : { appBundleId: app.bundleId };
}

/**
 * An app device opens in the background, so the frontmost app and every other session's app stay
 * where they are, and a link alone goes to the device's own app, not the default handler.
 */
export async function openMacOsApp(
  device: DeviceInfo,
  app: string,
  options?: { appBundleId?: string; url?: string },
): Promise<void> {
  const openOptions = { background: device.hostApp !== undefined };
  const target = app.trim();
  if (device.hostApp && isDeepLinkTarget(target)) {
    await resolveMacOsHostProvider().openBundle(device.hostApp.bundleId, target, openOptions);
    return;
  }
  const explicitUrl = options?.url?.trim();
  if (explicitUrl) {
    if (!isDeepLinkTarget(explicitUrl)) {
      throw new AppError('INVALID_ARGS', 'open <app> <url> requires a valid URL target');
    }
    const appId = options?.appBundleId ?? (await resolveMacOsApp(app));
    assertAppDeviceBundle(device, appId);
    await resolveMacOsHostProvider().openBundle(appId, explicitUrl, openOptions);
    return;
  }

  if (isDeepLinkTarget(target)) {
    await resolveMacOsHostProvider().openTarget(target, openOptions);
    return;
  }

  const bundleId = options?.appBundleId ?? (await resolveMacOsApp(target));
  assertAppDeviceBundle(device, bundleId);
  await resolveMacOsHostProvider().openBundle(bundleId, undefined, openOptions);
}

export async function closeMacOsApp(
  device: DeviceInfo,
  app: string,
  env: Readonly<EnvMap>,
): Promise<void> {
  const bundleId = await resolveMacOsApp(app);
  assertAppDeviceBundle(device, bundleId);
  const request = await quitMacOsApp(bundleId, env);
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
    if (!(await quitMacOsApp(bundleId, env)).running) return;
  }
  throw new AppError('COMMAND_FAILED', `Timed out waiting for macOS app ${app} to close`, {
    reason: 'MACOS_APP_TERMINATION_TIMEOUT',
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
      reason: 'app-device-scope',
      bundleId: app.bundleId,
      hint: 'Open the other app in a new --session. To open a link in this app, pass the link alone.',
    },
  );
}

export async function readMacOsClipboardText(): Promise<string> {
  return await resolveMacOsHostProvider().readClipboard();
}

export async function writeMacOsClipboardText(text: string): Promise<void> {
  await resolveMacOsHostProvider().writeClipboard(text);
}

async function getMacOsDarkModeEnabled(): Promise<boolean> {
  return await resolveMacOsHostProvider().readDarkMode();
}

export async function setMacOsAppearance(state: string): Promise<void> {
  const action = parseAppearanceAction(state);
  const darkMode = action === 'toggle' ? !(await getMacOsDarkModeEnabled()) : action === 'dark';
  await resolveMacOsHostProvider().setDarkMode(darkMode);
}

export async function listMacApps(filter: AppsFilter): Promise<IosAppInfo[]> {
  return await resolveMacOsHostProvider().listApps(filter);
}

function resolveMacOsHostProvider(): AppleMacOsHostProvider {
  const host = resolveAppleToolProvider().macosHost;
  if (!host) {
    throw new AppError('UNSUPPORTED_OPERATION', 'macOS host provider is not available');
  }
  return host;
}
