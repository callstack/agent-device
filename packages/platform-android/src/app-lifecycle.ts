import { AppError } from '@agent-device/kernel/errors';
import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';
import { Deadline, sleep } from '@agent-device/host-kit/retry';
import type { AppsFilter } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { isDeepLinkTarget } from '@agent-device/contracts/command';

import { waitForAndroidBoot } from './emulator-lifecycle.ts';
import { runAndroidShell } from './adb.ts';
import type { AndroidAdbExecutorResult } from './adb-transport.ts';
import {
  androidAdbResultError,
  createAndroidPortReverseManager,
  resolveAndroidAdbProvider,
  type AndroidPortReverseEndpoint,
} from './adb-executor.ts';
import {
  androidAppsDiscoveryHint,
  inferAndroidAppName,
  resolveAndroidApp,
} from './app-deployment-resolution.ts';
import {
  parseAndroidLaunchablePackages,
  parseAndroidUserInstalledPackages,
} from './app-parsers.ts';
import { androidLaunchCategory, androidLauncherCategories } from './launcher-categories.ts';
import { getAndroidAppState, getAndroidResumedActivity } from './window-state.ts';

const ANDROID_DEFAULT_CATEGORY = 'android.intent.category.DEFAULT';
const ANDROID_LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** Owns localhost URL reverses, so a teardown that removes only owned mappings removes them too. */
const ANDROID_LOCALHOST_URL_REVERSE_OWNER = 'localhost-url';
const ANDROID_CLOSE_FOCUS_TIMEOUT_MS = 2_000;
const ANDROID_CLOSE_FOCUS_POLL_MS = 50;
const ANDROID_CLOSE_PROCESS_TIMEOUT_MS = 2_000;
/**
 * Bounds the exit of processes that ran before `am force-stop`. Their exit time grows with memory
 * and device load, so this bound only catches a wedged device.
 */
const ANDROID_CLOSE_KILLED_EXIT_TIMEOUT_MS = 10_000;
const ANDROID_CLOSE_PROCESS_POLL_MS = 50;
const ANDROID_CLOSE_PROCESS_GONE_STABLE_MS = 150;

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
  for (const category of androidLauncherCategories(device.target, {
    includeFallbackCategories: true,
  })) {
    const result = await runAndroidShell(
      device,
      [
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

async function listAndroidUserInstalledPackages(device: DeviceInfo): Promise<string[]> {
  const result = await runAndroidShell(device, ['pm', 'list', 'packages', '-3']);
  return parseAndroidUserInstalledPackages(result.stdout);
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
    await reverse.ensure({
      local: endpoint,
      remote: endpoint,
      ownerId: ANDROID_LOCALHOST_URL_REVERSE_OWNER,
    });
  } catch (error) {
    const details = {
      localPort: endpoint.replace('tcp:', ''),
      operation: `adb reverse ${endpoint} ${endpoint}`,
    };
    if (error instanceof AppError) {
      Object.assign(details, {
        reason: error.details?.reason,
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
  /** Force-stops the app the target resolves to before starting it. */
  terminateRunningApp?: boolean;
  url?: string;
};

const ANDROID_PACKAGE_NAME = String.raw`[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*`;
const JAVA_IDENTIFIER = String.raw`[A-Za-z_$][A-Za-z0-9_$]*`;

/**
 * `am start -n` takes `<package>/<class>`: manifest package segments start with a letter, and class
 * segments are Java identifiers, `$` included for a nested class. A bare class (`.Main` or `Main`)
 * is resolved against the launched package.
 */
const ANDROID_ACTIVITY_COMPONENT = new RegExp(
  `^(?:${ANDROID_PACKAGE_NAME}/)?\\.?${JAVA_IDENTIFIER}(?:\\.${JAVA_IDENTIFIER})*$`,
);

function requireAndroidActivityComponent(activity: string): void {
  if (ANDROID_ACTIVITY_COMPONENT.test(activity)) return;
  throw new AppError('INVALID_ARGS', `Invalid Android activity component: ${activity}`, {
    reason: 'invalid-android-activity-component',
    activity,
    hint: 'Pass --activity as <package>/<Class>, .<Class>, or <Class>, using letters, digits, `_`, `.`, and `$`.',
  });
}

/** The `am start -n` component for an activity override, refused unless it is a component name. */
export function androidActivityComponent(packageName: string, activity: string): string {
  requireAndroidActivityComponent(activity);
  if (activity.includes('/')) return activity;
  return `${packageName}/${activity.startsWith('.') ? activity : `.${activity}`}`;
}

function androidLaunchArgs(options: OpenAndroidAppOptions): string[] {
  return options.launchArgs ?? [];
}

/** Opens the target and returns the package `am start -W` reports it launched, when reported. */
export async function openAndroidApp(
  device: DeviceInfo,
  app: string,
  optionsOrActivity?: OpenAndroidAppOptions | string,
): Promise<string | undefined> {
  return launchedAndroidPackage(await startAndroidApp(device, app, optionsOrActivity));
}

async function startAndroidApp(
  device: DeviceInfo,
  app: string,
  optionsOrActivity?: OpenAndroidAppOptions | string,
): Promise<AndroidAdbExecutorResult> {
  const options = normalizeOpenAndroidAppOptions(optionsOrActivity);
  const activity = options.activity;
  if (activity !== undefined) requireAndroidActivityComponent(activity);
  if (!device.booted) {
    await waitForAndroidBoot(device.id);
  }
  const deepLinkTarget = app.trim();
  if (isDeepLinkTarget(deepLinkTarget)) {
    return await openAndroidDeepLink(device, deepLinkTarget, options);
  }
  if (options.url !== undefined) {
    return await openAndroidAppBoundDeepLink(device, app, options);
  }
  const helperLaunch = await tryAndroidHelperLaunch(device, app, options);
  if (helperLaunch) return helperLaunch;
  const resolved = await resolveAndroidApp(device, app);
  const launchCategory = androidLaunchCategory(device.target);
  if (resolved.type === 'intent') {
    return await openAndroidIntent(device, resolved.value, options);
  }
  if (options.terminateRunningApp) await stopAndroidPackage(device, resolved.value);
  if (activity) {
    return await openAndroidPackageActivity(
      device,
      resolved.value,
      activity,
      launchCategory,
      options,
    );
  }
  return await openAndroidPackage(device, resolved.value, launchCategory, options);
}

async function tryAndroidHelperLaunch(
  device: DeviceInfo,
  app: string,
  options: OpenAndroidAppOptions,
): Promise<AndroidAdbExecutorResult | undefined> {
  const packageName = app.trim();
  if (
    device.target === 'tv' ||
    options.activity !== undefined ||
    androidLaunchArgs(options).length > 0 ||
    options.terminateRunningApp ||
    !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)
  )
    return undefined;
  const { runAndroidAutomationHelper } = await import('./automation-helper.ts');
  const result = await runAndroidAutomationHelper(device, {
    action: 'app',
    input: { kind: 'open', packageName },
  });
  if (!result) return undefined;
  if (
    result.kind === 'component-unavailable' &&
    !(await isAndroidPackageInstalled(device, packageName))
  )
    throw buildAndroidPackageNotInstalledError(packageName);
  const stdout = result.kind === 'launched' ? result.output : '';
  if (!/^Status: ok\r?$/m.test(stdout)) {
    throw new AppError('COMMAND_FAILED', 'Android helper could not launch the application', {
      packageName,
      stdout,
    });
  }
  return { stdout, stderr: '', exitCode: 0 };
}

/** `am start -W` names the activity this launch resumed on its `Activity: <package>/<class>` line. */
function launchedAndroidPackage(result: AndroidAdbExecutorResult): string | undefined {
  const line = result.stdout.split('\n').find((entry) => entry.trim().startsWith('Activity:'));
  return line?.split(':')[1]?.trim().split('/')[0] || undefined;
}

async function openAndroidDeepLink(
  device: DeviceInfo,
  target: string,
  options: OpenAndroidAppOptions,
): Promise<AndroidAdbExecutorResult> {
  if (options.activity) {
    throw new AppError(
      'INVALID_ARGS',
      'Activity override is not supported when opening a deep link URL',
    );
  }
  await ensureAndroidLocalhostReverse(device, target);
  return await runAndroidShell(device, [
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
): Promise<AndroidAdbExecutorResult> {
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
  const resolved = await requireAndroidPackageForOpen(device, app, 'app-bound open');
  if (options.terminateRunningApp) await stopAndroidPackage(device, resolved);
  return await runAndroidShell(device, [
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
): Promise<AndroidAdbExecutorResult> {
  if (options.activity) {
    throw new AppError('INVALID_ARGS', 'Activity override requires a package name, not an intent');
  }
  return await runAndroidShell(device, [
    'am',
    'start',
    '-W',
    ...(options.terminateRunningApp ? ['-S'] : []),
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
): Promise<AndroidAdbExecutorResult> {
  const component = androidActivityComponent(packageName, activity);
  try {
    return await runAndroidShell(
      device,
      buildAndroidActivityLaunchArgs(component, launchCategory, options),
    );
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
): Promise<AndroidAdbExecutorResult> {
  const primaryResult = await runAndroidShell(
    device,
    [
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
    return primaryResult;
  }
  const resolvedComponent = await resolveAndroidLaunchComponent(device, packageName);
  if (!resolvedComponent) {
    if (!(await isAndroidPackageInstalled(device, packageName))) {
      throw buildAndroidPackageNotInstalledError(packageName);
    }
    throw androidAdbResultError(`Failed to launch ${packageName}`, primaryResult);
  }
  // The fallback launches under the category the component actually resolved under, which on a TV
  // target can be LAUNCHER for an app that declares no LEANBACK_LAUNCHER activity.
  return await runAndroidShell(
    device,
    buildAndroidActivityLaunchArgs(
      resolvedComponent.component,
      resolvedComponent.category,
      options,
    ),
  );
}

function buildAndroidActivityLaunchArgs(
  component: string,
  launchCategory: string,
  options: OpenAndroidAppOptions,
): string[] {
  return [
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

async function requireAndroidPackageForOpen(
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
    hint: androidAppsDiscoveryHint,
  });
}

async function isAndroidPackageInstalled(
  device: DeviceInfo,
  packageName: string,
): Promise<boolean> {
  const result = await runAndroidShell(device, ['pm', 'path', packageName], {
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
): Promise<{ component: string; category: string } | null> {
  const categories = androidLauncherCategories(device.target, {
    includeFallbackCategories: true,
  });
  for (const category of categories) {
    const result = await runAndroidShell(
      device,
      [
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
    if (component) return { component, category };
  }
  return null;
}

export function isAmStartError(stdout: string, stderr: string): boolean {
  return `${stdout}\n${stderr}`.split('\n').some((line) => {
    const normalized = line.toLowerCase();
    return (
      normalized.startsWith('error:') &&
      (normalized.includes('activity not started') ||
        normalized.includes('unable to resolve intent'))
    );
  });
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
  await stopAndroidPackage(device, await resolveAndroidPackageToEnd(device, app, 'Close'));
}

async function resolveAndroidPackageToEnd(
  device: DeviceInfo,
  app: string,
  verb: 'Close' | 'Kill',
): Promise<string> {
  if (app.trim().toLowerCase() === 'settings') return 'com.android.settings';
  const resolved = await resolveAndroidApp(device, app);
  if (resolved.type === 'intent') {
    throw new AppError('INVALID_ARGS', `${verb} requires a package name, not an intent`);
  }
  return resolved.value;
}

async function stopAndroidPackage(device: DeviceInfo, packageName: string): Promise<void> {
  const killed = await readAndroidPackagePids(device, packageName);
  if (!killed) {
    throw androidPidofUnavailableError(packageName);
  }
  await runAndroidShell(device, ['am', 'force-stop', packageName]);
  const expired = await waitForAndroidPackageStopped(device, packageName, killed);
  if (expired) throw androidCloseTimeoutError(packageName, expired);
}

/**
 * System-initiated process death (`am kill`), which only reaps a background process, unlike
 * `closeAndroidApp`'s `am force-stop`. A resumed target is refused, and a process that survives
 * the kill fails rather than reading as success.
 */
export async function killAndroidApp(device: DeviceInfo, app: string): Promise<void> {
  await killAndroidPackage(device, await resolveAndroidPackageToEnd(device, app, 'Kill'));
}

async function killAndroidPackage(device: DeviceInfo, packageName: string): Promise<void> {
  const resumed = await getAndroidResumedActivity(device);
  if (resumed.status === 'resumed' && resumed.package === packageName) {
    throw new AppError('COMMAND_FAILED', `Cannot kill foreground app ${packageName}`, {
      reason: 'android-kill-requires-background-app',
      hint: 'Background the app before killApp (for example pressKey: Home): am kill only reaps background processes.',
    });
  }
  if (resumed.status === 'unknown') {
    throw new AppError(
      'COMMAND_FAILED',
      `Could not read resumed activity state before killing ${packageName}`,
      {
        reason: 'android-process-probe-unavailable',
        hint: 'adb dumpsys did not answer; retry once the device is reachable.',
      },
    );
  }
  await runAndroidShell(device, ['am', 'kill', packageName]);
  // Both fences run as on close, but a survivor is classified below rather than refused as a
  // close timeout.
  await waitForAndroidPackageNotForeground(device, packageName);
  await waitForAndroidPackageProcessGone(device, packageName);
  const process = await readAndroidPackageProcessState(device, packageName);
  if (process === 'running') {
    throw new AppError('COMMAND_FAILED', `am kill did not stop ${packageName}`, {
      reason: 'android-kill-process-survived',
      hint: 'The process survived am kill (for example a foreground service keeps it alive): use stopApp (am force-stop) to terminate it.',
    });
  }
  if (process === 'unknown') {
    throw androidPidofUnavailableError(packageName);
  }
}

function androidPidofUnavailableError(packageName: string): AppError {
  return new AppError('COMMAND_FAILED', `Could not read process state for ${packageName}`, {
    reason: 'android-process-probe-unavailable',
    hint: 'adb pidof did not answer; retry once the device is reachable.',
  });
}

type AndroidStopFencePhase = 'foreground' | 'exit' | 'process';

/**
 * The fence that expired before the package stopped, or undefined once it stopped. `killed` holds
 * the pids that ran before `am force-stop`; any other pid afterwards is a new process.
 */
async function waitForAndroidPackageStopped(
  device: DeviceInfo,
  packageName: string,
  killed: ReadonlySet<string>,
): Promise<AndroidStopFencePhase | undefined> {
  if (!(await waitForAndroidPackageNotForeground(device, packageName))) return 'foreground';
  if (!(await waitForAndroidKilledProcessesExit(device, packageName, killed))) return 'exit';
  if (!(await waitForAndroidPackageProcessGone(device, packageName))) return 'process';
  return undefined;
}

const ANDROID_CLOSE_TIMEOUTS: Record<
  AndroidStopFencePhase,
  { readonly message: string; readonly timeoutMs: number }
> = {
  foreground: {
    message: 'remained foreground after close',
    timeoutMs: ANDROID_CLOSE_FOCUS_TIMEOUT_MS,
  },
  exit: {
    message: 'process that ran before close did not exit',
    timeoutMs: ANDROID_CLOSE_KILLED_EXIT_TIMEOUT_MS,
  },
  process: {
    message: 'process remained running after close',
    timeoutMs: ANDROID_CLOSE_PROCESS_TIMEOUT_MS,
  },
};

function androidCloseTimeoutError(packageName: string, phase: AndroidStopFencePhase): AppError {
  const { message, timeoutMs } = ANDROID_CLOSE_TIMEOUTS[phase];
  return new AppError('COMMAND_FAILED', `Android app ${packageName} ${message}`, {
    reason: 'android-app-close-timeout',
    phase,
    packageName,
    timeoutMs,
  });
}

async function waitForAndroidPackageNotForeground(
  device: DeviceInfo,
  packageName: string,
): Promise<boolean> {
  const deadline = Deadline.fromTimeoutMs(ANDROID_CLOSE_FOCUS_TIMEOUT_MS);
  while (!deadline.isExpired()) {
    const foreground = await probeBeforeDeadline(deadline, () => readAndroidForegroundApp(device));
    if (!foreground) break;
    if (foreground.value?.package !== packageName) return true;
    await sleep(ANDROID_CLOSE_FOCUS_POLL_MS);
  }
  return false;
}

async function probeBeforeDeadline<T>(
  deadline: Deadline,
  probe: () => Promise<T>,
): Promise<{ value: T } | undefined> {
  const value = await probe();
  return deadline.isExpired() ? undefined : { value };
}

async function readAndroidForegroundApp(device: DeviceInfo): Promise<AppStateRuntimeResult | null> {
  const foreground = await getAndroidAppState(device);
  return foreground.package ? foreground : null;
}

async function waitForAndroidKilledProcessesExit(
  device: DeviceInfo,
  packageName: string,
  killed: ReadonlySet<string>,
): Promise<boolean> {
  if (killed.size === 0) return true;
  const deadline = Deadline.fromTimeoutMs(ANDROID_CLOSE_KILLED_EXIT_TIMEOUT_MS);
  while (!deadline.isExpired()) {
    const pids = await probeBeforeDeadline(deadline, () =>
      readAndroidPackagePids(device, packageName),
    );
    if (!pids) break;
    if (pids.value && ![...pids.value].some((pid) => killed.has(pid))) return true;
    await sleep(ANDROID_CLOSE_PROCESS_POLL_MS);
  }
  return false;
}

async function waitForAndroidPackageProcessGone(
  device: DeviceInfo,
  packageName: string,
): Promise<boolean> {
  const deadline = Deadline.fromTimeoutMs(ANDROID_CLOSE_PROCESS_TIMEOUT_MS);
  const probeProcessRunning = () =>
    probeBeforeDeadline(
      deadline,
      async () => (await readAndroidPackageProcessState(device, packageName)) === 'running',
    );
  while (!deadline.isExpired()) {
    const processRunning = await probeProcessRunning();
    if (!processRunning) break;
    if (!processRunning.value) {
      await sleep(ANDROID_CLOSE_PROCESS_GONE_STABLE_MS);
      if (deadline.isExpired()) break;
      const processStillRunning = await probeProcessRunning();
      if (!processStillRunning) break;
      if (!processStillRunning.value) return true;
    }
    await sleep(ANDROID_CLOSE_PROCESS_POLL_MS);
  }
  return false;
}

async function readAndroidPackageProcessState(
  device: DeviceInfo,
  packageName: string,
): Promise<'running' | 'gone' | 'unknown'> {
  const pids = await readAndroidPackagePids(device, packageName);
  if (!pids) return 'unknown';
  return pids.size > 0 ? 'running' : 'gone';
}

/** The package's running pids, or undefined when `pidof` did not answer. */
async function readAndroidPackagePids(
  device: DeviceInfo,
  packageName: string,
): Promise<Set<string> | undefined> {
  const result = await runAndroidShell(device, ['pidof', packageName], {
    allowFailure: true,
  });
  const pids = (result.stdout ?? '').trim();
  if (pids.length > 0) return new Set(pids.split(/\s+/));
  // `pidof` exits 1 with empty streams when no process matches.
  if ((result.exitCode === 0 || result.exitCode === 1) && (result.stderr ?? '').trim() === '') {
    return new Set();
  }
  return undefined;
}
