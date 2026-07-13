import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFileOverridePath, runCmd, whichCmd } from '../../utils/exec.ts';
import { AppError } from '../../kernel/errors.ts';
import { sleep } from '../../utils/timeouts.ts';
import type { AppsFilter } from '../../contracts/app-inventory.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { isDeepLinkTarget } from '../../contracts/open-target.ts';
import { createAppResolutionCache, type AppResolutionCacheScope } from '../app-resolution-cache.ts';
import { waitForAndroidBoot } from './devices.ts';
import { runAndroidAdb } from './adb.ts';
import {
  androidAdbResultError,
  createAndroidPortReverseManager,
  installAndroidAdbPackage,
  resolveAndroidAdbProvider,
  type AndroidPortReverseEndpoint,
} from './adb-executor.ts';
import { classifyAndroidAppTarget } from './open-target.ts';
import { prepareAndroidInstallArtifact } from './install-artifact.ts';
import {
  parseAndroidForegroundApp,
  parseAndroidBlockingDialogFocus,
  parseAndroidLaunchablePackages,
  parseAndroidUserInstalledPackages,
  type AndroidBlockingDialogFocus,
  type AndroidForegroundApp,
} from './app-parsers.ts';

export {
  parseAndroidForegroundApp,
  parseAndroidLaunchablePackages,
  parseAndroidUserInstalledPackages,
  type AndroidBlockingDialogFocus,
  type AndroidForegroundApp,
} from './app-parsers.ts';

const ALIASES: Record<string, { type: 'intent' | 'package'; value: string }> = {
  settings: { type: 'intent', value: 'android.settings.SETTINGS' },
};
const ANDROID_LAUNCHER_CATEGORY = 'android.intent.category.LAUNCHER';
const ANDROID_LEANBACK_CATEGORY = 'android.intent.category.LEANBACK_LAUNCHER';
const ANDROID_DEFAULT_CATEGORY = 'android.intent.category.DEFAULT';
const ANDROID_APPS_DISCOVERY_HINT =
  'Run agent-device apps --platform android to discover the installed package name, then retry open with that exact package.';
const ANDROID_AMBIGUOUS_APP_HINT =
  'Run agent-device apps --platform android to see the exact installed package names before retrying open.';
const ANDROID_LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ANDROID_CLOSE_FOCUS_TIMEOUT_MS = 2_000;
const ANDROID_CLOSE_FOCUS_POLL_MS = 50;
const ANDROID_CLOSE_PROCESS_TIMEOUT_MS = 2_000;
const ANDROID_CLOSE_PROCESS_POLL_MS = 50;
const ANDROID_CLOSE_PROCESS_GONE_STABLE_MS = 150;

type AndroidAppResolution = { type: 'intent' | 'package'; value: string };

const androidAppResolutionCache = createAppResolutionCache<AndroidAppResolution>();

function androidAppResolutionScope(device: DeviceInfo): AppResolutionCacheScope {
  return { platform: 'android', deviceId: device.id, variant: device.target ?? '' };
}

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
    hint: ANDROID_APPS_DISCOVERY_HINT,
  });
}

export async function listAndroidApps(
  device: DeviceInfo,
  filter: AppsFilter,
): Promise<Array<{ package: string; name: string }>> {
  const launchable = await listAndroidLaunchablePackages(device);
  const packageIds =
    filter === 'user-installed'
      ? (await listAndroidUserInstalledPackages(device)).filter((pkg) => launchable.has(pkg))
      : Array.from(launchable);
  return packageIds
    .sort((a, b) => a.localeCompare(b))
    .map((pkg) => ({ package: pkg, name: inferAndroidAppName(pkg) }));
}

async function listAndroidLaunchablePackages(device: DeviceInfo): Promise<Set<string>> {
  const packages = new Set<string>();
  for (const category of resolveAndroidLaunchCategories(device, {
    includeFallbackWhenUnknown: true,
  })) {
    const result = await runAndroidAdb(
      device,
      [
        'shell',
        'cmd',
        'package',
        'query-activities',
        '--brief',
        '-a',
        'android.intent.action.MAIN',
        '-c',
        category,
      ],
      { allowFailure: true },
    );
    if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
      continue;
    }
    for (const pkg of parseAndroidLaunchablePackages(result.stdout)) {
      packages.add(pkg);
    }
  }
  return packages;
}

function resolveAndroidLauncherCategory(device: DeviceInfo): string {
  return resolveAndroidLaunchCategories(device)[0] ?? ANDROID_LAUNCHER_CATEGORY;
}

function resolveAndroidLaunchCategories(
  device: DeviceInfo,
  options: { includeFallbackWhenUnknown?: boolean } = {},
): string[] {
  if (device.target === 'tv') {
    return [ANDROID_LEANBACK_CATEGORY];
  }
  if (device.target === 'mobile') {
    return [ANDROID_LAUNCHER_CATEGORY];
  }
  if (options.includeFallbackWhenUnknown) {
    return [ANDROID_LAUNCHER_CATEGORY, ANDROID_LEANBACK_CATEGORY];
  }
  return [ANDROID_LAUNCHER_CATEGORY];
}

async function listAndroidUserInstalledPackages(device: DeviceInfo): Promise<string[]> {
  const result = await runAndroidAdb(device, ['shell', 'pm', 'list', 'packages', '-3']);
  return parseAndroidUserInstalledPackages(result.stdout);
}

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
  // Fallback to last token if every token is ignored (e.g. "com.android.app.services" → "Services").
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

export async function getAndroidAppState(device: DeviceInfo): Promise<AndroidForegroundApp> {
  const windowFocus = await readAndroidFocus(device, [
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'dumpsys', 'window'],
  ]);
  if (windowFocus) return windowFocus;

  const activityFocus = await readAndroidFocus(device, [
    ['shell', 'dumpsys', 'activity', 'activities'],
    ['shell', 'dumpsys', 'activity'],
  ]);
  if (activityFocus) return activityFocus;
  return {};
}

export async function getAndroidBlockingDialogFocus(
  device: DeviceInfo,
): Promise<AndroidBlockingDialogFocus | null> {
  return await readAndroidBlockingDialogFocus(device, [
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'dumpsys', 'window'],
  ]);
}

async function readAndroidFocus(
  device: DeviceInfo,
  commands: string[][],
): Promise<AndroidForegroundApp | null> {
  for (const args of commands) {
    const result = await runAndroidAdb(device, args, { allowFailure: true });
    const text = result.stdout ?? '';
    const parsed = parseAndroidForegroundApp(text);
    if (parsed) return parsed;
  }
  return null;
}

async function readAndroidBlockingDialogFocus(
  device: DeviceInfo,
  commands: string[][],
): Promise<AndroidBlockingDialogFocus | null> {
  for (const args of commands) {
    const result = await runAndroidAdb(device, args, { allowFailure: true });
    const parsed = parseAndroidBlockingDialogFocus(result.stdout ?? '');
    if (parsed) return parsed;
  }
  return null;
}

function androidLocalhostReverseEndpoint(target: string): AndroidPortReverseEndpoint | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  if (!ANDROID_LOCALHOST_HOSTNAMES.has(hostname)) return null;
  if (!url.port) return null;
  const port = Number(url.port);
  if (!Number.isInteger(port)) return null;
  return `tcp:${port}`;
}

async function ensureAndroidLocalhostReverse(device: DeviceInfo, target: string): Promise<void> {
  const endpoint = androidLocalhostReverseEndpoint(target);
  if (!endpoint) return;

  const reverse = createAndroidPortReverseManager(resolveAndroidAdbProvider(device));
  try {
    await reverse.ensure({ local: endpoint, remote: endpoint });
  } catch (error) {
    const details = {
      localPort: endpoint.replace('tcp:', ''),
      operation: `adb reverse ${endpoint} ${endpoint}`,
    };
    if (error instanceof AppError) {
      Object.assign(details, {
        hint: error.details?.hint,
        diagnosticId: error.details?.diagnosticId,
        logPath: error.details?.logPath,
      });
    }
    throw new AppError(
      'COMMAND_FAILED',
      `Failed to ensure Android port reverse ${endpoint} before opening localhost URL`,
      details,
      error,
    );
  }
}

export type OpenAndroidAppOptions = {
  activity?: string;
  appBundleId?: string;
  launchArgs?: string[];
  url?: string;
};

// `adb shell` joins its argv with spaces and feeds the result to a device
// shell, which re-tokenises. The other `am start` arguments (action, category,
// component, etc.) are well-known and never contain shell-significant
// characters, so they round-trip untouched. Launch arguments are user-supplied
// and may contain JSON, spaces, `#`, etc.; each is single-quoted unless it
// consists entirely of safe shell characters.
function quoteAndroidShellArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function androidLaunchArgs(options: OpenAndroidAppOptions): string[] {
  return (options.launchArgs ?? []).map(quoteAndroidShellArg);
}

export async function openAndroidApp(
  device: DeviceInfo,
  app: string,
  optionsOrActivity?: OpenAndroidAppOptions | string,
): Promise<void> {
  if (!device.booted) {
    await waitForAndroidBoot(device.id);
  }
  const options = normalizeOpenAndroidAppOptions(optionsOrActivity);
  const activity = options.activity;
  const deepLinkTarget = app.trim();
  if (isDeepLinkTarget(deepLinkTarget)) {
    await openAndroidDeepLink(device, deepLinkTarget, options);
    return;
  }
  if (options.url !== undefined) {
    await openAndroidAppBoundDeepLink(device, app, options);
    return;
  }
  const resolved = await resolveAndroidApp(device, app);
  const launchCategory = resolveAndroidLauncherCategory(device);
  if (resolved.type === 'intent') {
    await openAndroidIntent(device, resolved.value, options);
    return;
  }
  if (activity) {
    await openAndroidPackageActivity(device, resolved.value, activity, launchCategory, options);
    return;
  }
  await openAndroidPackage(device, resolved.value, launchCategory, options);
}

async function openAndroidDeepLink(
  device: DeviceInfo,
  target: string,
  options: OpenAndroidAppOptions,
): Promise<void> {
  if (options.activity) {
    throw new AppError(
      'INVALID_ARGS',
      'Activity override is not supported when opening a deep link URL',
    );
  }
  await ensureAndroidLocalhostReverse(device, target);
  await runAndroidAdb(device, [
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    target,
    ...androidDeepLinkPackageArgs(options.appBundleId),
    ...androidLaunchArgs(options),
  ]);
}

async function openAndroidAppBoundDeepLink(
  device: DeviceInfo,
  app: string,
  options: OpenAndroidAppOptions,
): Promise<void> {
  if (options.activity) {
    throw new AppError(
      'INVALID_ARGS',
      'Activity override is not supported when opening an app-bound deep link URL',
    );
  }
  const deepLinkUrl = options.url?.trim() ?? '';
  if (!isDeepLinkTarget(deepLinkUrl)) {
    throw new AppError('INVALID_ARGS', 'Android app-bound open requires a valid URL target');
  }
  await ensureAndroidLocalhostReverse(device, deepLinkUrl);
  const resolved = await resolveAndroidPackageForOpen(device, app, 'app-bound open');
  await runAndroidAdb(device, [
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    deepLinkUrl,
    '-p',
    resolved,
    ...androidLaunchArgs(options),
  ]);
}

async function openAndroidIntent(
  device: DeviceInfo,
  intent: string,
  options: OpenAndroidAppOptions,
): Promise<void> {
  if (options.activity) {
    throw new AppError('INVALID_ARGS', 'Activity override requires a package name, not an intent');
  }
  await runAndroidAdb(device, [
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    intent,
    ...androidLaunchArgs(options),
  ]);
}

async function openAndroidPackageActivity(
  device: DeviceInfo,
  packageName: string,
  activity: string,
  launchCategory: string,
  options: OpenAndroidAppOptions,
): Promise<void> {
  const component = activity.includes('/')
    ? activity
    : `${packageName}/${activity.startsWith('.') ? activity : `.${activity}`}`;
  try {
    await runAndroidAdb(device, buildAndroidActivityLaunchArgs(component, launchCategory, options));
  } catch (error) {
    await maybeRethrowAndroidMissingPackageError(device, packageName, error);
    throw error;
  }
}

async function openAndroidPackage(
  device: DeviceInfo,
  packageName: string,
  launchCategory: string,
  options: OpenAndroidAppOptions,
): Promise<void> {
  const primaryResult = await runAndroidAdb(
    device,
    [
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      ANDROID_DEFAULT_CATEGORY,
      '-c',
      launchCategory,
      '-p',
      packageName,
      ...androidLaunchArgs(options),
    ],
    { allowFailure: true },
  );
  if (primaryResult.exitCode === 0 && !isAmStartError(primaryResult.stdout, primaryResult.stderr)) {
    return;
  }
  const component = await resolveAndroidLaunchComponent(device, packageName);
  if (!component) {
    if (!(await isAndroidPackageInstalled(device, packageName))) {
      throw buildAndroidPackageNotInstalledError(packageName);
    }
    throw androidAdbResultError(`Failed to launch ${packageName}`, primaryResult);
  }
  await runAndroidAdb(device, buildAndroidActivityLaunchArgs(component, launchCategory, options));
}

function buildAndroidActivityLaunchArgs(
  component: string,
  launchCategory: string,
  options: OpenAndroidAppOptions,
): string[] {
  return [
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    ANDROID_DEFAULT_CATEGORY,
    '-c',
    launchCategory,
    '-n',
    component,
    ...androidLaunchArgs(options),
  ];
}

async function resolveAndroidPackageForOpen(
  device: DeviceInfo,
  app: string,
  label: string,
): Promise<string> {
  const resolved = await resolveAndroidApp(device, app);
  if (resolved.type === 'intent') {
    throw new AppError('INVALID_ARGS', `Android ${label} requires a package name, not an intent`);
  }
  return resolved.value;
}

function normalizeOpenAndroidAppOptions(
  optionsOrActivity: OpenAndroidAppOptions | string | undefined,
): OpenAndroidAppOptions {
  if (typeof optionsOrActivity === 'string') return { activity: optionsOrActivity };
  return optionsOrActivity ?? {};
}

function androidDeepLinkPackageArgs(packageName: string | undefined): string[] {
  const normalized = packageName?.trim();
  return normalized ? ['-p', normalized] : [];
}

function buildAndroidPackageNotInstalledError(packageName: string): AppError {
  return new AppError('APP_NOT_INSTALLED', `No package found matching "${packageName}"`, {
    package: packageName,
    hint: ANDROID_APPS_DISCOVERY_HINT,
  });
}

async function isAndroidPackageInstalled(
  device: DeviceInfo,
  packageName: string,
): Promise<boolean> {
  const result = await runAndroidAdb(device, ['shell', 'pm', 'path', packageName], {
    allowFailure: true,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode === 0 && /\bpackage:/i.test(output)) {
    return true;
  }
  if (looksLikeMissingAndroidPackageOutput(output)) {
    return false;
  }
  return false;
}

async function maybeRethrowAndroidMissingPackageError(
  device: DeviceInfo,
  packageName: string,
  error: unknown,
): Promise<void> {
  const output =
    error instanceof AppError
      ? `${String(error.details?.stdout ?? '')}\n${String(error.details?.stderr ?? '')}`
      : '';
  if (looksLikeMissingAndroidPackageOutput(output)) {
    throw buildAndroidPackageNotInstalledError(packageName);
  }
  if (!(await isAndroidPackageInstalled(device, packageName))) {
    throw buildAndroidPackageNotInstalledError(packageName);
  }
}

function looksLikeMissingAndroidPackageOutput(output: string): boolean {
  return (
    /\bunknown package\b/i.test(output) ||
    /\bpackage .* (?:was|is) not found\b/i.test(output) ||
    /\bpackage .* does not exist\b/i.test(output) ||
    /\bcould not find package\b/i.test(output)
  );
}

async function resolveAndroidLaunchComponent(
  device: DeviceInfo,
  packageName: string,
): Promise<string | null> {
  const categories = Array.from(
    new Set(resolveAndroidLaunchCategories(device, { includeFallbackWhenUnknown: true })),
  );
  for (const category of categories) {
    const result = await runAndroidAdb(
      device,
      [
        'shell',
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '-a',
        'android.intent.action.MAIN',
        '-c',
        category,
        packageName,
      ],
      { allowFailure: true },
    );
    if (result.exitCode !== 0) {
      continue;
    }
    const component = parseAndroidLaunchComponent(result.stdout);
    if (component) return component;
  }
  return null;
}

export function isAmStartError(stdout: string, stderr: string): boolean {
  const output = `${stdout}\n${stderr}`;
  return /Error:.*(?:Activity not started|unable to resolve Intent)/i.test(output);
}

export function parseAndroidLaunchComponent(stdout: string): string | null {
  const lines = stdout
    .split('\n')
    .map((line: string) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (!line.includes('/')) continue;
    const component = line.split(/\s+/)[0];
    if (component !== undefined) return component;
  }
  return null;
}

export async function openAndroidDevice(device: DeviceInfo): Promise<void> {
  if (!device.booted) {
    await waitForAndroidBoot(device.id);
  }
}

export async function closeAndroidApp(device: DeviceInfo, app: string): Promise<void> {
  const trimmed = app.trim();
  if (trimmed.toLowerCase() === 'settings') {
    await runAndroidAdb(device, ['shell', 'am', 'force-stop', 'com.android.settings']);
    await waitForAndroidPackageStopped(device, 'com.android.settings');
    return;
  }
  const resolved = await resolveAndroidApp(device, app);
  if (resolved.type === 'intent') {
    throw new AppError('INVALID_ARGS', 'Close requires a package name, not an intent');
  }
  await runAndroidAdb(device, ['shell', 'am', 'force-stop', resolved.value]);
  await waitForAndroidPackageStopped(device, resolved.value);
}

async function waitForAndroidPackageStopped(
  device: DeviceInfo,
  packageName: string,
): Promise<void> {
  await waitForAndroidPackageNotForeground(device, packageName);
  await waitForAndroidPackageProcessGone(device, packageName);
}

async function waitForAndroidPackageNotForeground(
  device: DeviceInfo,
  packageName: string,
): Promise<void> {
  const deadline = Date.now() + ANDROID_CLOSE_FOCUS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const foreground = await readAndroidForegroundApp(device);
    if (foreground?.package !== packageName) return;
    await sleep(ANDROID_CLOSE_FOCUS_POLL_MS);
  }
}

async function readAndroidForegroundApp(device: DeviceInfo): Promise<AndroidForegroundApp | null> {
  for (const args of [
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'dumpsys', 'window'],
    ['shell', 'dumpsys', 'activity', 'activities'],
    ['shell', 'dumpsys', 'activity'],
  ]) {
    const result = await runAndroidAdb(device, args, { allowFailure: true });
    const parsed = parseAndroidForegroundApp(result.stdout ?? '');
    if (parsed) return parsed;
  }
  return null;
}

async function waitForAndroidPackageProcessGone(
  device: DeviceInfo,
  packageName: string,
): Promise<void> {
  const deadline = Date.now() + ANDROID_CLOSE_PROCESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isAndroidPackageProcessRunning(device, packageName))) {
      await sleep(ANDROID_CLOSE_PROCESS_GONE_STABLE_MS);
      if (!(await isAndroidPackageProcessRunning(device, packageName))) return;
    }
    await sleep(ANDROID_CLOSE_PROCESS_POLL_MS);
  }
}

async function isAndroidPackageProcessRunning(
  device: DeviceInfo,
  packageName: string,
): Promise<boolean> {
  const result = await runAndroidAdb(device, ['shell', 'pidof', packageName], {
    allowFailure: true,
  });
  return (result.stdout ?? '').trim().length > 0;
}

async function uninstallAndroidApp(device: DeviceInfo, app: string): Promise<{ package: string }> {
  const resolved = await resolveAndroidApp(device, app);
  if (resolved.type === 'intent') {
    throw new AppError('INVALID_ARGS', 'App uninstall requires a package name, not an intent');
  }
  const result = await runAndroidAdb(device, ['uninstall', resolved.value], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (!output.includes('unknown package') && !output.includes('not installed')) {
      throw androidAdbResultError(`adb uninstall failed for ${resolved.value}`, result);
    }
  }
  return { package: resolved.value };
}

type BundletoolInvocation =
  | { cmd: 'bundletool'; prefixArgs: readonly string[] }
  | { cmd: 'java'; prefixArgs: readonly string[] };

// Module-level cache for bundletool resolution.  Safe for the single-threaded
// Node.js event loop; concurrent async callers may race to populate it but will
// resolve to the same value since the inputs (PATH, env var) are stable per
// process lifetime.
let cachedBundletoolInvocation: { key: string; invocation: BundletoolInvocation } | null = null;

function bundletoolInvocationCacheKey(): string {
  return `${process.env.PATH ?? ''}::${process.env.AGENT_DEVICE_BUNDLETOOL_JAR ?? ''}`;
}

async function resolveBundletoolInvocation(): Promise<BundletoolInvocation> {
  const cacheKey = bundletoolInvocationCacheKey();
  if (cachedBundletoolInvocation?.key === cacheKey) {
    return cachedBundletoolInvocation.invocation;
  }

  if (await whichCmd('bundletool')) {
    const invocation = { cmd: 'bundletool', prefixArgs: [] } as const;
    cachedBundletoolInvocation = { key: cacheKey, invocation };
    return invocation;
  }

  const bundletoolJar = await resolveFileOverridePath(
    process.env.AGENT_DEVICE_BUNDLETOOL_JAR,
    'AGENT_DEVICE_BUNDLETOOL_JAR',
  );
  if (!bundletoolJar) {
    throw new AppError(
      'TOOL_MISSING',
      'bundletool not found in PATH. Install bundletool or set AGENT_DEVICE_BUNDLETOOL_JAR to a bundletool-all.jar path.',
    );
  }
  const invocation = { cmd: 'java', prefixArgs: ['-jar', bundletoolJar] } as const;
  cachedBundletoolInvocation = { key: cacheKey, invocation };
  return invocation;
}

async function runBundletool(args: string[]): Promise<void> {
  const invocation = await resolveBundletoolInvocation();
  await runCmd(invocation.cmd, [...invocation.prefixArgs, ...args]);
}

function isAndroidAppBundlePath(appPath: string): boolean {
  return path.extname(appPath).toLowerCase() === '.aab';
}

async function installAndroidAppBundle(device: DeviceInfo, appPath: string): Promise<void> {
  const provider = resolveAndroidAdbProvider(device);
  const mode = 'universal';
  if (provider.installBundle) {
    await provider.installBundle(appPath, { mode });
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-aab-'));
  const apksPath = path.join(tempDir, 'bundle.apks');
  try {
    await runBundletool(['build-apks', '--bundle', appPath, '--output', apksPath, '--mode', mode]);
    await runBundletool(['install-apks', '--apks', apksPath, '--device-id', device.id]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function installAndroidAppFiles(device: DeviceInfo, appPath: string): Promise<void> {
  if (isAndroidAppBundlePath(appPath)) {
    await installAndroidAppBundle(device, appPath);
    return;
  }
  await installAndroidAdbPackage(appPath, {
    device,
    replace: true,
  });
}

async function listInstalledAndroidPackages(device: DeviceInfo): Promise<Set<string>> {
  const result = await runAndroidAdb(device, ['shell', 'pm', 'list', 'packages']);
  return new Set(
    result.stdout
      .split('\n')
      .map((line: string) => line.replace('package:', '').trim())
      .filter(Boolean),
  );
}

async function resolveInstalledAndroidPackageName(
  device: DeviceInfo,
  beforePackages: Set<string>,
): Promise<string | undefined> {
  const afterPackages = await listInstalledAndroidPackages(device);
  const installedNow = Array.from(afterPackages).filter((pkg) => !beforePackages.has(pkg));
  if (installedNow.length === 1) return installedNow[0];
  return undefined;
}

export async function installAndroidInstallablePath(
  device: DeviceInfo,
  installablePath: string,
): Promise<void> {
  await androidAppResolutionCache.invalidateWhile(androidAppResolutionScope(device), async () => {
    if (!device.booted) {
      await waitForAndroidBoot(device.id);
    }
    await installAndroidAppFiles(device, installablePath);
  });
}

export async function installAndroidInstallablePathAndResolvePackageName(
  device: DeviceInfo,
  installablePath: string,
  packageNameHint?: string,
): Promise<string | undefined> {
  const beforePackages = packageNameHint ? undefined : await listInstalledAndroidPackages(device);
  await installAndroidInstallablePath(device, installablePath);
  return (
    packageNameHint ??
    (beforePackages ? await resolveInstalledAndroidPackageName(device, beforePackages) : undefined)
  );
}

export async function installAndroidApp(
  device: DeviceInfo,
  appPath: string,
): Promise<{
  archivePath?: string;
  installablePath: string;
  packageName?: string;
  appName?: string;
  launchTarget?: string;
}> {
  if (!device.booted) {
    await waitForAndroidBoot(device.id);
  }
  const prepared = await prepareAndroidInstallArtifact({ kind: 'path', path: appPath });
  try {
    const packageName = await installAndroidInstallablePathAndResolvePackageName(
      device,
      prepared.installablePath,
      prepared.packageName,
    );
    const appName = packageName ? inferAndroidAppName(packageName) : undefined;
    return {
      archivePath: prepared.archivePath,
      installablePath: prepared.installablePath,
      packageName,
      appName,
      launchTarget: packageName,
    };
  } finally {
    await prepared.cleanup();
  }
}

export async function reinstallAndroidApp(
  device: DeviceInfo,
  app: string,
  appPath: string,
): Promise<{ package: string }> {
  return await androidAppResolutionCache.invalidateWhile(
    androidAppResolutionScope(device),
    async () => {
      if (!device.booted) {
        await waitForAndroidBoot(device.id);
      }
      const { package: pkg } = await uninstallAndroidApp(device, app);
      const prepared = await prepareAndroidInstallArtifact(
        { kind: 'path', path: appPath },
        { resolveIdentity: false },
      );
      try {
        await installAndroidInstallablePath(device, prepared.installablePath);
      } finally {
        await prepared.cleanup();
      }
      return { package: pkg };
    },
  );
}
