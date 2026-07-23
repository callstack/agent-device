import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIosFamily, isMacOs, type DeviceInfo } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import type { AppsFilter } from '../../../contracts/app-inventory.ts';
import {
  createAppResolutionCache,
  type AppResolutionCacheScope,
} from '../../app-resolution-cache.ts';
import { listIosDeviceApps } from './devicectl.ts';
import type { IosAppInfo } from './app-info.ts';
import { filterAppleAppsByBundlePrefix } from './app-filter.ts';
import { listMacApps, resolveMacOsApp } from '../os/macos/apps.ts';
import { runAppleToolCommand } from './tool-provider.ts';
import { runSimctl } from './apps-simctl.ts';

const ALIASES: Record<string, string> = {
  settings: 'com.apple.Preferences',
};
const AGENT_DEVICE_RUNNER_BUNDLE_PREFIX = 'com.callstack.agentdevice.runner';

const iosAppResolutionCache = createAppResolutionCache<string>();

function iosAppResolutionScope(device: DeviceInfo): AppResolutionCacheScope {
  return { platform: 'ios', deviceId: device.id, variant: device.kind };
}

export async function invalidateIosAppResolutionCache<T>(
  device: DeviceInfo,
  fn: () => Promise<T>,
): Promise<T> {
  return await iosAppResolutionCache.invalidateWhile(iosAppResolutionScope(device), fn);
}

export async function resolveIosApp(device: DeviceInfo, app: string): Promise<string> {
  if (isMacOs(device)) {
    return await resolveMacOsApp(app);
  }
  const trimmed = app.trim();
  if (trimmed.includes('.')) return trimmed;

  const alias = resolveIosAppAlias(trimmed);
  if (alias !== trimmed) return alias;

  const cacheScope = iosAppResolutionScope(device);
  const cached = iosAppResolutionCache.get(cacheScope, trimmed);
  if (cached) return cached;

  const list =
    device.kind === 'simulator'
      ? await listSimulatorApps(device)
      : await listIosDeviceApps(device, 'all');
  const matches = list.filter((entry) => entry.name.toLowerCase() === trimmed.toLowerCase());
  const match = matches[0];
  if (match !== undefined && matches.length === 1) {
    return iosAppResolutionCache.set(cacheScope, trimmed, match.bundleId);
  }
  if (matches.length > 1) {
    throw new AppError('INVALID_ARGS', `Multiple apps matched "${app}"`, { matches });
  }

  throw new AppError('APP_NOT_INSTALLED', `No app found matching "${app}"`);
}

/**
 * Resolves an app only when it is installed on this booted simulator.
 *
 * Device selection uses this narrower lookup before it has committed to a
 * simulator, so an exact bundle id must not take resolveIosApp's normal
 * pass-through path.
 */
export async function findIosSimulatorInstalledApp(
  device: DeviceInfo,
  app: string,
): Promise<string | undefined> {
  if (!isIosFamily(device) || device.kind !== 'simulator' || device.booted !== true) {
    return undefined;
  }

  const target = resolveIosAppAlias(app.trim());
  if (!target) return undefined;

  const apps = await listSimulatorApps(device);
  if (target.includes('.')) {
    return apps.find((entry) => entry.bundleId === target)?.bundleId;
  }

  const matches = apps.filter((entry) => entry.name.toLowerCase() === target.toLowerCase());
  return matches.length === 1 ? matches[0]?.bundleId : undefined;
}

export function resolveIosAppAlias(app: string): string {
  const trimmed = app.trim();
  return ALIASES[trimmed.toLowerCase()] ?? app;
}

type SimulatorAppMetadata = {
  bundleId: string;
  name: string;
  path?: string;
  applicationType?: string;
};

export async function resolveIosSimulatorDeepLinkBundleId(
  device: DeviceInfo,
  url: string,
): Promise<string | undefined> {
  if (!isIosFamily(device) || device.kind !== 'simulator') return undefined;
  const scheme = parseUrlScheme(url);
  if (!scheme) return undefined;

  const apps = await listSimulatorAppMetadata(device);
  const matches: SimulatorAppMetadata[] = [];
  for (const app of apps) {
    if (app.bundleId.startsWith(AGENT_DEVICE_RUNNER_BUNDLE_PREFIX)) continue;
    if (!app.path) continue;
    const schemes = await readIosSimulatorAppUrlSchemes(path.join(app.path, 'Info.plist'));
    if (schemes.has(scheme)) {
      matches.push(app);
    }
  }

  const userMatches = matches.filter((app) => app.applicationType === 'User');
  if (userMatches.length === 1) return userMatches[0]?.bundleId;
  if (userMatches.length > 1) return undefined;
  return matches.length === 1 ? matches[0]?.bundleId : undefined;
}

function parseUrlScheme(url: string): string | undefined {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url.trim());
  return match?.[1]?.toLowerCase();
}

export async function listIosApps(device: DeviceInfo, filter: AppsFilter): Promise<IosAppInfo[]> {
  if (isMacOs(device)) {
    return await listMacApps(filter);
  }
  if (device.kind === 'simulator') {
    const apps = await listSimulatorApps(device);
    return filterAppleAppsByBundlePrefix(apps, filter);
  }
  return await listIosDeviceApps(device, filter);
}

async function listSimulatorApps(device: DeviceInfo): Promise<IosAppInfo[]> {
  const apps = await listSimulatorAppMetadata(device);
  return apps.map((app) => ({
    bundleId: app.bundleId,
    name: app.name,
  }));
}

async function listSimulatorAppMetadata(device: DeviceInfo): Promise<SimulatorAppMetadata[]> {
  const result = await runSimctl(device, ['listapps', device.id], { allowFailure: true });
  const stdout = result.stdout as string;
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let parsed: Record<
    string,
    {
      ApplicationType?: string;
      Bundle?: string;
      CFBundleDisplayName?: string;
      CFBundleName?: string;
      Path?: string;
    }
  > | null = null;
  if (trimmed.startsWith('{')) {
    try {
      parsed = JSON.parse(trimmed) as Record<
        string,
        {
          ApplicationType?: string;
          Bundle?: string;
          CFBundleDisplayName?: string;
          CFBundleName?: string;
          Path?: string;
        }
      >;
    } catch {
      parsed = null;
    }
  }

  if (!parsed && trimmed.startsWith('{')) {
    try {
      const converted = await runAppleToolCommand('plutil', ['-convert', 'json', '-o', '-', '-'], {
        allowFailure: true,
        stdin: trimmed,
      });
      if (converted.exitCode === 0 && converted.stdout.trim().startsWith('{')) {
        parsed = JSON.parse(converted.stdout) as Record<
          string,
          {
            ApplicationType?: string;
            Bundle?: string;
            CFBundleDisplayName?: string;
            CFBundleName?: string;
            Path?: string;
          }
        >;
      }
    } catch {
      parsed = null;
    }
  }

  if (!parsed) return [];
  return Object.entries(parsed).map(([bundleId, info]) => {
    const appPath = resolveSimulatorAppPath(info);
    return {
      bundleId,
      name: info.CFBundleDisplayName ?? info.CFBundleName ?? bundleId,
      ...(appPath ? { path: appPath } : {}),
      ...(info.ApplicationType ? { applicationType: info.ApplicationType } : {}),
    };
  });
}

function resolveSimulatorAppPath(info: { Bundle?: string; Path?: string }): string | undefined {
  if (info.Path) return info.Path;
  if (!info.Bundle) return undefined;
  try {
    return fileURLToPath(info.Bundle);
  } catch {
    return undefined;
  }
}

async function readIosSimulatorAppUrlSchemes(infoPlistPath: string): Promise<Set<string>> {
  const result = await runAppleToolCommand(
    'plutil',
    ['-convert', 'json', '-o', '-', infoPlistPath],
    {
      allowFailure: true,
    },
  );
  if (result.exitCode !== 0) return new Set();
  try {
    const parsed = JSON.parse(result.stdout) as {
      CFBundleURLTypes?: Array<{ CFBundleURLSchemes?: unknown }>;
    };
    const schemes = new Set<string>();
    for (const urlType of parsed.CFBundleURLTypes ?? []) {
      if (!Array.isArray(urlType.CFBundleURLSchemes)) continue;
      for (const scheme of urlType.CFBundleURLSchemes) {
        if (typeof scheme === 'string' && scheme.trim()) {
          schemes.add(scheme.trim().toLowerCase());
        }
      }
    }
    return schemes;
  } catch {
    return new Set();
  }
}
