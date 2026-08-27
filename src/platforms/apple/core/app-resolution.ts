import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isIosFamily, isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { AppsFilter } from '@agent-device/contracts/device';
import {
  createAppResolutionCache,
  type AppResolutionCacheScope,
} from '@agent-device/provision-kit/app-resolution-cache';
import type { IosAppInfo } from './app-info.ts';
import { filterAppleAppsByBundlePrefix } from './app-filter.ts';
import { listMacApps, resolveMacOsApp } from '../os/macos/apps.ts';
import { runAppleToolCommand } from './tool-provider.ts';
import { runSimctl } from './apps-simctl.ts';
import { resolveIosPhysicalDeviceControl } from './physical-device-control.ts';
import { createTtlMemo } from '@agent-device/kernel/ttl-memo';

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
      : await resolveIosPhysicalDeviceControl(device).listApps(device, 'all');
  const matches = list.filter((entry) => entry.name.toLowerCase() === trimmed.toLowerCase());
  const match = matches[0];
  if (match !== undefined && matches.length === 1) {
    return iosAppResolutionCache.set(cacheScope, trimmed, match.bundleId);
  }
  if (matches.length > 1) {
    throw new AppError('INVALID_ARGS', `Multiple apps matched "${app}"`, { matches });
  }

  throw buildAppNotInstalledError(app);
}

// Exported as the single name-lookup APP_NOT_INSTALLED producer so the
// help-benchmark sample parity test renders the exact error this resolver
// throws; a message change here fails that gate instead of drifting past it.
export function buildAppNotInstalledError(app: string): AppError {
  return new AppError('APP_NOT_INSTALLED', `No app found matching "${app}"`);
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

// Bounded so an error-path probe never turns into a long wait.
const IOS_FOREGROUND_APP_PROBE_TIMEOUT_MS = 3_000;
const UIKIT_APPLICATION_JOB_PATTERN = /UIKitApplication:([^[\s]+)\[/;

/**
 * Identifies the sole installed app currently running on a booted simulator,
 * for enriching error hints — never for functional resolution (ambiguity
 * must fail, not guess).
 *
 * `launchctl list` reports every running job, including simulator-internal
 * services (Spotlight, widget renderers, parental controls) that are not
 * real apps. Cross-referencing against `simctl listapps` (the installed-app
 * registry) filters those out without hardcoding a system bundle-id
 * denylist that would drift across iOS versions. Returns `undefined`
 * whenever this isn't a single confident answer: no running app, more than
 * one, or the probe itself failed.
 */
export async function detectSoleRunningIosSimulatorApp(
  device: DeviceInfo,
): Promise<IosAppInfo | undefined> {
  if (!isIosFamily(device) || device.kind !== 'simulator' || device.booted !== true) {
    return undefined;
  }

  // Both probes are bounded, but a timeout still REJECTS (exec.ts's
  // `allowFailure` only suppresses non-zero exit codes, not a timeout or a
  // spawn failure) — this is an error-path enrichment, so any throw here
  // must fall back to "inconclusive", never propagate and replace the
  // caller's deterministic error with a probe failure.
  try {
    const [runningBundleIds, installedApps] = await Promise.all([
      listRunningIosSimulatorBundleIds(device),
      listSimulatorApps(device, { timeoutMs: IOS_FOREGROUND_APP_PROBE_TIMEOUT_MS }),
    ]);
    if (runningBundleIds.length === 0) return undefined;

    const installedById = new Map(installedApps.map((app) => [app.bundleId, app] as const));
    const candidates = new Map<string, IosAppInfo>();
    for (const bundleId of runningBundleIds) {
      const app = installedById.get(bundleId);
      if (app) candidates.set(app.bundleId, app);
    }
    return candidates.size === 1 ? [...candidates.values()][0] : undefined;
  } catch {
    return undefined;
  }
}

async function listRunningIosSimulatorBundleIds(device: DeviceInfo): Promise<string[]> {
  const result = await runSimctl(device, ['spawn', device.id, 'launchctl', 'list'], {
    allowFailure: true,
    timeoutMs: IOS_FOREGROUND_APP_PROBE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return [];

  const bundleIds: string[] = [];
  for (const line of (result.stdout as string).split('\n')) {
    const match = UIKIT_APPLICATION_JOB_PATTERN.exec(line);
    if (match?.[1]) bundleIds.push(match[1]);
  }
  return bundleIds;
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
  return await resolveIosPhysicalDeviceControl(device).listApps(device, filter);
}

type SimulatorAppListOptions = {
  /** Unset (default) preserves prior unbounded behavior for normal command flow. */
  timeoutMs?: number;
};

async function listSimulatorApps(
  device: DeviceInfo,
  options?: SimulatorAppListOptions,
): Promise<IosAppInfo[]> {
  const apps = await listSimulatorAppMetadata(device, options);
  return apps.map((app) => ({
    bundleId: app.bundleId,
    name: app.name,
  }));
}

async function listSimulatorAppMetadata(
  device: DeviceInfo,
  options?: SimulatorAppListOptions,
): Promise<SimulatorAppMetadata[]> {
  const result = await runSimctl(device, ['listapps', device.id], {
    allowFailure: true,
    timeoutMs: options?.timeoutMs,
  });
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
        timeoutMs: options?.timeoutMs,
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

// One plutil spawn per installed app per deep-link lookup dominates open
// scheme:// latency; schemes only change when the bundle is reinstalled, so
// the mtime-keyed memo absorbs the per-lookup cost. Only successful parses are
// cacheable — a transient probe failure must not pin empty schemes until TTL
// expiry — and expiry is scheduled so abandoned install paths do not
// accumulate in a long-lived daemon.
const IOS_SIMULATOR_APP_URL_SCHEME_MEMO_TTL_MS = 30 * 60_000;
const iosSimulatorAppUrlSchemeMemo = createTtlMemo<string, Set<string>>({
  ttlMs: IOS_SIMULATOR_APP_URL_SCHEME_MEMO_TTL_MS,
  scheduleExpiry: true,
});

async function readIosSimulatorAppUrlSchemes(infoPlistPath: string): Promise<Set<string>> {
  let cacheKey: string | undefined;
  try {
    cacheKey = `${infoPlistPath}:${(await fs.stat(infoPlistPath)).mtimeMs}`;
  } catch {
    cacheKey = undefined;
  }
  if (cacheKey === undefined) {
    return (await readIosSimulatorAppUrlSchemesUncached(infoPlistPath)) ?? new Set();
  }
  const cached = iosSimulatorAppUrlSchemeMemo.get(cacheKey);
  if (cached) return cached;
  const schemes = await readIosSimulatorAppUrlSchemesUncached(infoPlistPath);
  if (schemes) iosSimulatorAppUrlSchemeMemo.set(cacheKey, schemes);
  return schemes ?? new Set();
}

/**
 * Returns the bundle's URL schemes, or `undefined` when the probe failed
 * (nonzero exit or malformed output) and the result must not be cached.
 */
async function readIosSimulatorAppUrlSchemesUncached(
  infoPlistPath: string,
): Promise<Set<string> | undefined> {
  const result = await runAppleToolCommand(
    'plutil',
    ['-convert', 'json', '-o', '-', infoPlistPath],
    {
      allowFailure: true,
    },
  );
  if (result.exitCode !== 0) return undefined;
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
    return undefined;
  }
}
