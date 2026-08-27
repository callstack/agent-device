import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  createAppResolutionCache,
  type AppResolutionCacheScope,
} from '@agent-device/provision-kit/app-resolution-cache';
import { runAndroidAdb } from './adb.ts';
import { classifyAndroidAppTarget } from './open-target.ts';

const ALIASES: Record<string, { type: 'intent' | 'package'; value: string }> = {
  settings: { type: 'intent', value: 'android.settings.SETTINGS' },
};
export const androidAppsDiscoveryHint =
  'Run agent-device apps --platform android to discover the installed package name, then retry open with that exact package.';
const ANDROID_AMBIGUOUS_APP_HINT =
  'Run agent-device apps --platform android to see the exact installed package names before retrying open.';

export type AndroidAppResolution = { type: 'intent' | 'package'; value: string };

const androidAppResolutionCache = createAppResolutionCache<AndroidAppResolution>();

function androidAppResolutionScope(device: DeviceInfo): AppResolutionCacheScope {
  return { platform: 'android', deviceId: device.id, variant: device.target ?? '' };
}

/** Brackets one package mutation so fuzzy target identity cannot survive it. */
export async function withAndroidAppResolutionCacheInvalidated<Result>(
  device: DeviceInfo,
  operation: () => Promise<Result>,
): Promise<Result> {
  return await androidAppResolutionCache.invalidateWhile(
    androidAppResolutionScope(device),
    operation,
  );
}

/** Resolves aliases and fuzzy display names to an Android intent or installed package. */
export async function resolveAndroidApp(
  device: DeviceInfo,
  app: string,
): Promise<AndroidAppResolution> {
  const trimmed = app.trim();
  if (classifyAndroidAppTarget(trimmed) === 'package') return { type: 'package', value: trimmed };

  const alias = ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;

  const cacheScope = androidAppResolutionScope(device);
  const cached = androidAppResolutionCache.get(cacheScope, trimmed);
  if (cached) return cached;

  const result = await runAndroidAdb(device, ['shell', 'pm', 'list', 'packages']);
  const packages = result.stdout
    .split('\n')
    .map((line: string) => line.replace('package:', '').trim())
    .filter(Boolean);

  const matches = packages.filter((pkg: string) =>
    pkg.toLowerCase().includes(trimmed.toLowerCase()),
  );
  const match = matches[0];
  if (match !== undefined && matches.length === 1) {
    return androidAppResolutionCache.set(cacheScope, trimmed, {
      type: 'package',
      value: match,
    });
  }

  if (matches.length > 1) {
    throw new AppError('INVALID_ARGS', `Multiple packages matched "${app}"`, {
      matches,
      hint: ANDROID_AMBIGUOUS_APP_HINT,
    });
  }

  throw new AppError('APP_NOT_INSTALLED', `No package found matching "${app}"`, {
    hint: androidAppsDiscoveryHint,
  });
}

/** Produces a readable display label when an Android provider reports only a package id. */
export function inferAndroidAppName(packageName: string): string {
  const ignoredTokens = new Set([
    'com',
    'android',
    'google',
    'app',
    'apps',
    'service',
    'services',
    'mobile',
    'client',
  ]);
  const tokens = packageName
    .split('.')
    .flatMap((segment) => segment.split(/[_-]+/))
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  let chosen = tokens[tokens.length - 1] ?? packageName;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token && !ignoredTokens.has(token)) {
      chosen = token;
      break;
    }
  }
  return chosen
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
