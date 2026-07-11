import type { AppsFilter } from '../../../../contracts/app-inventory.ts';
import { isDeepLinkTarget } from '../../../../contracts/open-target.ts';
import type { DeviceInfo } from '../../../../kernel/device.ts';
import { AppError } from '../../../../kernel/errors.ts';
import { parseAppearanceAction } from '../../../appearance.ts';
import {
  createAppResolutionCache,
  type AppResolutionCacheScope,
} from '../../../app-resolution-cache.ts';
import { quitMacOsApp } from './helper.ts';
import { resolveAppleToolProvider, type AppleMacOsHostProvider } from '../../core/tool-provider.ts';
import type { IosAppInfo } from '../../core/app-info.ts';

const MACOS_ALIASES: Record<string, string> = {
  settings: 'com.apple.systempreferences',
};

const MACOS_BUNDLE_ID_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

// macOS currently has no install/uninstall flow; add cache invalidation if that changes.
const MACOS_APP_RESOLUTION_CACHE_SCOPE = {
  platform: 'macos',
  deviceId: 'host',
  variant: 'all',
} satisfies AppResolutionCacheScope;
const macOsAppResolutionCache = createAppResolutionCache<string>();

function isMacOsBundleId(value: string): boolean {
  return MACOS_BUNDLE_ID_PATTERN.test(value);
}

export async function resolveMacOsApp(app: string): Promise<string> {
  const trimmed = app.trim();

  const alias = MACOS_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  if (isMacOsBundleId(trimmed)) {
    return trimmed;
  }

  const cached = macOsAppResolutionCache.get(MACOS_APP_RESOLUTION_CACHE_SCOPE, trimmed);
  if (cached) return cached;

  const apps = await listMacApps('all');
  const matches = apps.filter((entry) => entry.name.toLowerCase() === trimmed.toLowerCase());
  const match = matches[0];
  if (match !== undefined && matches.length === 1) {
    return macOsAppResolutionCache.set(MACOS_APP_RESOLUTION_CACHE_SCOPE, trimmed, match.bundleId);
  }
  if (matches.length > 1) {
    throw new AppError('INVALID_ARGS', `Multiple apps matched "${app}"`, { matches });
  }

  throw new AppError('APP_NOT_INSTALLED', `No app found matching "${app}"`);
}

export async function openMacOsApp(
  _device: DeviceInfo,
  app: string,
  options?: { appBundleId?: string; url?: string },
): Promise<void> {
  const explicitUrl = options?.url?.trim();
  if (explicitUrl) {
    if (!isDeepLinkTarget(explicitUrl)) {
      throw new AppError('INVALID_ARGS', 'open <app> <url> requires a valid URL target');
    }
    const appId = options?.appBundleId ?? (await resolveMacOsApp(app));
    await resolveMacOsHostProvider().openBundle(appId, explicitUrl);
    return;
  }

  const target = app.trim();
  if (isDeepLinkTarget(target)) {
    await resolveMacOsHostProvider().openTarget(target);
    return;
  }

  const bundleId = options?.appBundleId ?? (await resolveMacOsApp(target));
  await resolveMacOsHostProvider().openBundle(bundleId);
}

export async function closeMacOsApp(_device: DeviceInfo, app: string): Promise<void> {
  const bundleId = await resolveMacOsApp(app);
  const result = await quitMacOsApp(bundleId);
  if (!result.running || result.terminated || result.forceTerminated) return;
  throw new AppError('COMMAND_FAILED', `Failed to close macOS app ${app}`, {
    bundleId,
    running: result.running,
    terminated: result.terminated,
    forceTerminated: result.forceTerminated,
  });
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
