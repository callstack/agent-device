import type { SimulatorAppListOptions, SimulatorAppMetadata } from './tool-provider-types.ts';
import { isIosFamily, isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { AppsFilter } from '@agent-device/contracts/device';
import {
  createAppResolutionCache,
  type AppResolutionCacheScope,
} from '@agent-device/provision-kit/app-resolution-cache';
import type { IosAppInfo } from './app-info.ts';
import { filterAppleAppsByBundlePrefix } from './app-filter.ts';
import { buildAppNotInstalledError } from './app-resolution-error.ts';
import { listMacApps, resolveMacOsApp } from '../os/macos/apps.ts';
import { resolveAppleToolProvider } from './tool-provider.ts';
import { resolveIosPhysicalDeviceControl } from './physical-device-control.ts';

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

type IosAppResolutionOptions = Readonly<{
  /**
   * On a simulator or device, answer only with an app installed on it now. A dotted target is then
   * matched against the installed bundle ids before display names, so `Booking.com` resolves
   * instead of passing through; no earlier resolution is reused, and a target nothing installed
   * matches is refused rather than returned as a literal id. The macOS host ignores it and resolves
   * through `resolveMacOsApp`.
   */
  installedOnly?: boolean;
}>;

export async function resolveIosApp(
  device: DeviceInfo,
  app: string,
  options: IosAppResolutionOptions = {},
): Promise<string> {
  if (isMacOs(device)) {
    return await resolveMacOsApp(app);
  }
  const trimmed = app.trim();
  const alias = resolveIosAppAlias(trimmed);
  const cacheScope = iosAppResolutionScope(device);
  if (!options.installedOnly) {
    if (trimmed.includes('.')) return trimmed;
    if (alias !== trimmed) return alias;
    const cached = iosAppResolutionCache.get(cacheScope, trimmed);
    if (cached) return cached;
  }

  const list =
    device.kind === 'simulator'
      ? await requireSimulatorApps(device)
      : await resolveIosPhysicalDeviceControl(device).listApps(device, 'all');
  return iosAppResolutionCache.set(
    cacheScope,
    trimmed,
    matchInstalledIosApp(list, app, trimmed, alias),
  );
}

/**
 * The installed app a target names: an alias or a dotted target by its bundle id first, and any
 * target but an alias by its display name.
 */
function matchInstalledIosApp(
  list: readonly IosAppInfo[],
  app: string,
  trimmed: string,
  alias: string,
): string {
  const isAlias = alias !== trimmed;
  if ((isAlias || trimmed.includes('.')) && list.some((entry) => entry.bundleId === alias)) {
    return alias;
  }
  if (isAlias) throw buildAppNotInstalledError(app);
  const matches = list.filter((entry) => entry.name.toLowerCase() === trimmed.toLowerCase());
  const match = matches[0];
  if (match !== undefined && matches.length === 1) return match.bundleId;
  if (matches.length > 1) {
    throw new AppError('INVALID_ARGS', `Multiple apps matched "${app}"`, { matches });
  }
  throw buildAppNotInstalledError(app);
}

export { buildAppNotInstalledError };

/**
 * Resolves an app only when it is installed on this booted simulator, by the `installedOnly` rule.
 * Device selection probes candidates with it, so a missing or ambiguous app and an app list `simctl`
 * could not produce all answer "not here" rather than failing the selection.
 */
export async function findIosSimulatorInstalledApp(
  device: DeviceInfo,
  app: string,
): Promise<string | undefined> {
  if (!isIosFamily(device) || device.kind !== 'simulator' || device.booted !== true) {
    return undefined;
  }
  if (!app.trim()) return undefined;
  try {
    return await resolveIosApp(device, app, { installedOnly: true });
  } catch (error) {
    if (isUnresolvedInstalledApp(error)) return undefined;
    throw error;
  }
}

function isUnresolvedInstalledApp(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  return (
    error.code === 'APP_NOT_INSTALLED' ||
    error.details?.reason === IOS_APP_LIST_UNREADABLE_REASON ||
    Array.isArray(error.details?.matches)
  );
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
  const { runSimctlForDevice } = await import('./simctl-execution.ts');
  const result = await runSimctlForDevice(device, ['spawn', device.id, 'launchctl', 'list'], {
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

/**
 * The installed app that owns `url`'s scheme, when exactly one does. `timeoutMs` is one deadline
 * shared by the app listing and every Info.plist read; a spawn it cuts short or `signal` aborts
 * rejects the lookup.
 */
export async function resolveIosSimulatorDeepLinkBundleId(
  device: DeviceInfo,
  url: string,
  options: SimulatorAppListOptions = {},
): Promise<string | undefined> {
  if (!isIosFamily(device) || device.kind !== 'simulator') return undefined;
  const scheme = parseUrlScheme(url);
  if (!scheme) return undefined;

  const { remainingLookupBudget } = await import('./simulator-app-budget.ts');
  const remaining = remainingLookupBudget(options);
  const apps = await listSimulatorAppMetadata(device, remaining());
  const candidates = apps.filter(
    (app) => !app.bundleId.startsWith(AGENT_DEVICE_RUNNER_BUNDLE_PREFIX),
  );
  const claims = await Promise.all(
    candidates.map(async (app) => ({
      app,
      schemes: await readInstalledAppUrlSchemes(device, app.bundleId, remaining(), app.path),
    })),
  );
  const matches = claims.filter(({ schemes }) => schemes.has(scheme)).map(({ app }) => app);
  const userMatches = matches.filter((app) => app.applicationType === 'User');
  if (userMatches.length === 1) return userMatches[0]?.bundleId;
  if (userMatches.length > 1) return undefined;
  return matches.length === 1 ? matches[0]?.bundleId : undefined;
}

const EXPO_DEV_CLIENT_SCHEME_PREFIX = 'exp+';

/** Resolves the app's sole, uniquely owned exp+ scheme within one shared deadline. */
export async function resolveIosSimulatorExpoDevClientScheme(
  device: DeviceInfo,
  bundleId: string,
  options: SimulatorAppListOptions = {},
): Promise<string | undefined> {
  if (!isIosFamily(device) || device.kind !== 'simulator') return undefined;
  const { remainingLookupBudget } = await import('./simulator-app-budget.ts');
  const remaining = remainingLookupBudget(options);
  const schemes = await readInstalledAppUrlSchemes(device, bundleId, remaining());
  const devClientSchemes = [...schemes].filter(
    (scheme) =>
      scheme.startsWith(EXPO_DEV_CLIENT_SCHEME_PREFIX) &&
      scheme.length > EXPO_DEV_CLIENT_SCHEME_PREFIX.length,
  );
  if (devClientSchemes.length !== 1) return undefined;
  const scheme = devClientSchemes[0];
  const owner = await resolveIosSimulatorDeepLinkBundleId(device, `${scheme}://`, remaining());
  return owner === bundleId ? scheme : undefined;
}

async function readInstalledAppUrlSchemes(
  device: DeviceInfo,
  bundleId: string,
  options: SimulatorAppListOptions,
  appPath?: string,
): Promise<Set<string>> {
  const plist = await resolveAppleToolProvider().simulatorApps.readInfoPlist({
    device,
    bundleId,
    appPath,
    ...options,
  });
  return urlSchemesFromPlist(plist);
}

function urlSchemesFromPlist(plist: Record<string, unknown> | null): Set<string> {
  const schemes = new Set<string>();
  const types = plist?.CFBundleURLTypes;
  if (!Array.isArray(types)) return schemes;
  for (const type of types) {
    if (!Array.isArray(type?.CFBundleURLSchemes)) continue;
    for (const value of type.CFBundleURLSchemes) {
      if (typeof value === 'string' && value.trim()) schemes.add(value.trim().toLowerCase());
    }
  }
  return schemes;
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

/** `details.reason` of an app resolution that failed because `simctl` produced no app list. */
const IOS_APP_LIST_UNREADABLE_REASON = 'app-list-unreadable';

/**
 * The installed apps an app resolution matches against. A listing `simctl` could not produce is a
 * failure of its own, never an empty list: reading it as one would report an installed app missing.
 */
async function requireSimulatorApps(device: DeviceInfo): Promise<IosAppInfo[]> {
  const read = await resolveAppleToolProvider().simulatorApps.list(device);
  if (read.type === 'unreadable') {
    throw new AppError('COMMAND_FAILED', `Could not list the apps installed on ${device.id}`, {
      reason: IOS_APP_LIST_UNREADABLE_REASON,
      deviceId: device.id,
      exitCode: read.exitCode,
      stderr: read.stderr,
      hint: 'Check that the simulator is booted and that `xcrun simctl listapps <udid>` answers, then retry.',
    });
  }
  return read.apps.map((app) => ({ bundleId: app.bundleId, name: app.name }));
}

async function listSimulatorAppMetadata(
  device: DeviceInfo,
  options?: SimulatorAppListOptions,
): Promise<SimulatorAppMetadata[]> {
  const read = await resolveAppleToolProvider().simulatorApps.list(device, options);
  return read.type === 'listed' ? read.apps : [];
}
