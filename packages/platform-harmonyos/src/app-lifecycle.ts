import { setTimeout as sleep } from 'node:timers/promises';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ShellWord } from '@agent-device/kernel/device-shell';
import { AppError } from '@agent-device/kernel/errors';
import type {
  OpenApplicationInput,
  OpenApplicationOutcome,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';
import { isDeepLinkTarget } from '@agent-device/contracts/command';
import { runCmd } from '@agent-device/host-kit/command';
import { runHarmonyShell } from './hdc.ts';
import { parseHarmonyForegroundApp } from './app-state.ts';
import { invalidateHarmonyGestureViewport } from './snapshot.ts';

export function parseHarmonyBundleList(rawOutput: string): string[] {
  return rawOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^([a-zA-Z0-9_]+\.)+[a-zA-Z0-9_]+$/.test(line));
}

export interface HarmonyLaunchTarget {
  ability: string;
  module?: string;
}

interface HarmonyBundleDump {
  appInfo?: {
    isSystemApp?: boolean;
  };
  applicationInfo?: {
    isSystemApp?: boolean;
  };
  hapModuleInfos?: Array<{
    mainElementName?: string;
    moduleName?: string;
  }>;
}

interface HarmonyArchiveModule {
  app?: { bundleName?: string };
}

const HARMONY_APP_INVENTORY_TIMEOUT_MS = 60_000;
const HARMONY_APP_METADATA_CONCURRENCY = 4;

interface HarmonyAppListOptions {
  signal?: AbortSignal;
}

/** Reads the bundle identity embedded in a signed HAP archive. */
export async function resolveHarmonyArchiveBundleName(
  archivePath: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await runCmd('unzip', ['-p', archivePath, 'module.json'], {
    allowFailure: true,
    timeoutMs: 15_000,
    signal,
  });
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) return undefined;
  try {
    const manifest = JSON.parse(result.stdout) as HarmonyArchiveModule;
    const bundleName = manifest.app?.bundleName?.trim();
    return bundleName || undefined;
  } catch {
    return undefined;
  }
}

/** Extracts the launchable page ability from `bm dump -n <bundle>`. */
export function parseHarmonyLaunchTarget(rawOutput: string): HarmonyLaunchTarget | undefined {
  const dump = parseHarmonyBundleDump(rawOutput);
  if (!dump) return undefined;
  const module = dump.hapModuleInfos?.find((item) => item.mainElementName);
  if (!module?.mainElementName) return undefined;
  return { ability: module.mainElementName, module: module.moduleName };
}

/** Reads Bundle Manager's structured system-app classification for one bundle. */
export function parseHarmonyIsSystemApp(rawOutput: string): boolean | undefined {
  const dump = parseHarmonyBundleDump(rawOutput);
  const isSystemApp = dump?.applicationInfo?.isSystemApp ?? dump?.appInfo?.isSystemApp;
  return typeof isSystemApp === 'boolean' ? isSystemApp : undefined;
}

function parseHarmonyBundleDump(rawOutput: string): HarmonyBundleDump | undefined {
  const jsonStart = rawOutput.indexOf('{');
  if (jsonStart === -1) return undefined;
  try {
    return JSON.parse(rawOutput.slice(jsonStart)) as HarmonyBundleDump;
  } catch {
    return undefined;
  }
}

export async function listHarmonyApps(
  device: DeviceInfo,
  filter: 'all' | 'user-installed',
  options: HarmonyAppListOptions = {},
): Promise<Array<{ package: string; name: string }>> {
  if (filter === 'all') {
    const result = await runHarmonyShell(device, ['bm', 'dump', '-a'], {
      timeoutMs: 15_000,
      signal: options.signal,
    });
    return harmonyAppEntries(parseHarmonyBundleList(result.stdout));
  }

  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(),
    HARMONY_APP_INVENTORY_TIMEOUT_MS,
  );
  const signal = combineHarmonySignals(options.signal, deadlineController.signal);
  try {
    const result = await runHarmonyShell(device, ['bm', 'dump', '-a'], {
      timeoutMs: 15_000,
      signal,
    });
    const packages = parseHarmonyBundleList(result.stdout);
    const userInstalledPackages = await listHarmonyUserInstalledPackages(device, packages, signal);
    return harmonyAppEntries(userInstalledPackages);
  } catch (error) {
    if (deadlineController.signal.aborted) {
      throw new AppError(
        'COMMAND_FAILED',
        'Timed out while classifying HarmonyOS application inventory',
        {
          hint: 'Use apps --all to list bundles without per-bundle classification, then retry after the device is responsive.',
        },
      );
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function harmonyAppEntries(packages: string[]): Array<{ package: string; name: string }> {
  return packages.map((pkg) => ({
    package: pkg,
    name: pkg.split('.').at(-1) ?? pkg,
  }));
}

async function listHarmonyUserInstalledPackages(
  device: DeviceInfo,
  packages: string[],
  parentSignal: AbortSignal | undefined,
): Promise<string[]> {
  const classifications = new Array<boolean>(packages.length);
  const workerFailure = new AbortController();
  const signal = combineHarmonySignals(parentSignal, workerFailure.signal);
  let nextPackageIndex = 0;
  let firstInitiatingFailure: unknown;
  const workerCount = Math.min(HARMONY_APP_METADATA_CONCURRENCY, packages.length);

  const workers = Array.from({ length: workerCount }, async () => {
    try {
      while (true) {
        signal?.throwIfAborted();
        const packageIndex = nextPackageIndex++;
        if (packageIndex >= packages.length) return;
        const bundleName = packages[packageIndex];
        if (!bundleName) return;
        const result = await runHarmonyShell(device, ['bm', 'dump', '-n', bundleName], {
          timeoutMs: 15_000,
          signal,
        });
        const isSystemApp = parseHarmonyIsSystemApp(result.stdout);
        if (isSystemApp === undefined) {
          throw new AppError(
            'COMMAND_FAILED',
            `Could not determine whether ${bundleName} is a system application`,
            {
              hint: 'Use apps --all to list all bundles when Bundle Manager does not expose applicationInfo.isSystemApp.',
            },
          );
        }
        classifications[packageIndex] = isSystemApp;
      }
    } catch (error) {
      if (!signal?.aborted && firstInitiatingFailure === undefined) {
        firstInitiatingFailure = error;
      }
      workerFailure.abort();
      throw error;
    }
  });

  const workerResults = await Promise.allSettled(workers);
  if (firstInitiatingFailure !== undefined) throw firstInitiatingFailure;
  const failure = workerResults.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
  return packages.filter((_, index) => !classifications[index]);
}

function combineHarmonySignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const definedSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (definedSignals.length === 0) return undefined;
  return definedSignals.length === 1 ? definedSignals[0] : AbortSignal.any(definedSignals);
}

/** A module.json5 ability name: a letter, then letters, digits, `_`, or `.`. */
const HARMONY_ABILITY_NAME = /^[A-Za-z][A-Za-z0-9_.]*$/;

function requireHarmonyAbilityName(ability: string): void {
  if (HARMONY_ABILITY_NAME.test(ability)) return;
  throw new AppError('INVALID_ARGS', `Invalid HarmonyOS ability name: ${ability}`, {
    reason: 'invalid-harmony-ability-name',
    ability,
    hint: 'Pass --activity as the ability name from module.json5, such as EntryAbility.',
  });
}

export async function openHarmonyApp(
  device: DeviceInfo,
  bundleId: string,
  options?: { activity?: string; signal?: AbortSignal },
): Promise<void> {
  if (options?.activity !== undefined) requireHarmonyAbilityName(options.activity);
  const launchTarget = options?.activity
    ? { ability: options.activity }
    : parseHarmonyLaunchTarget(
        (
          await runHarmonyShell(device, ['bm', 'dump', '-n', bundleId], {
            signal: options?.signal,
            timeoutMs: 15_000,
          })
        ).stdout,
      );
  if (!launchTarget) {
    throw new AppError(
      'COMMAND_FAILED',
      `Could not determine a launchable ability for ${bundleId}`,
      {
        hint: 'Pass --activity with the HarmonyOS ability name, or check that the bundle is installed.',
      },
    );
  }
  const words: ShellWord[] = ['aa', 'start', '-a', launchTarget.ability, '-b', bundleId];
  if (launchTarget.module) words.push('-m', launchTarget.module);
  const result = await runHarmonyShell(device, words, { signal: options?.signal });
  if (!result.stdout.includes('start ability successfully')) {
    throw new AppError('COMMAND_FAILED', `Failed to start ${bundleId}`, {
      details: { output: result.stdout.trim() },
    });
  }
  invalidateHarmonyGestureViewport(device);
}

/** How long an open may keep re-reading the foreground before it accepts what it last saw. */
export const HARMONY_OPEN_FOREGROUND_POLL_BUDGET_MS = 5_000;
/** One foreground read per interval until the budget runs out; the first read costs no wait. */
const HARMONY_OPEN_FOREGROUND_POLL_INTERVAL_MS = 500;

/** What one bounded foreground poll decided about a launched bundle. */
export type HarmonyOpenForegroundRead = Readonly<{
  confirmed: boolean;
  foregroundPackage?: string;
}>;

/**
 * Reads which HarmonyOS mission holds the foreground until the launched bundle does, the poll
 * budget runs out, or the request is aborted. A read that names no FOREGROUND mission (the
 * lock-screen shape) or fails to run counts as unconfirmed and keeps polling.
 */
export async function pollHarmonyOpenForeground(
  device: DeviceInfo,
  bundleId: string,
  options: Readonly<{
    signal?: AbortSignal;
    pollBudgetMs?: number;
    pollIntervalMs?: number;
  }> = {},
): Promise<HarmonyOpenForegroundRead> {
  const pollBudgetMs = options.pollBudgetMs ?? HARMONY_OPEN_FOREGROUND_POLL_BUDGET_MS;
  const pollIntervalMs = options.pollIntervalMs ?? HARMONY_OPEN_FOREGROUND_POLL_INTERVAL_MS;
  const deadlineAtMs = Date.now() + pollBudgetMs;
  let foregroundPackage: string | undefined;
  while (true) {
    options.signal?.throwIfAborted();
    const foregroundPackageRead = (await readHarmonyForegroundMission(device, options.signal))
      ?.package;
    if (foregroundPackageRead === bundleId) return { confirmed: true };
    if (foregroundPackageRead !== undefined) foregroundPackage = foregroundPackageRead;
    if (Date.now() >= deadlineAtMs) {
      return foregroundPackage === undefined
        ? { confirmed: false }
        : { confirmed: false, foregroundPackage };
    }
    await sleep(pollIntervalMs, undefined, { signal: options.signal });
  }
}

/** One foreground read; a failed or unreadable read answers undefined instead of throwing. */
async function readHarmonyForegroundMission(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<AppStateRuntimeResult | undefined> {
  try {
    const result = await runHarmonyShell(device, ['aa', 'dump', '-l'], {
      signal,
      timeoutMs: 5_000,
    });
    return parseHarmonyForegroundApp(result.stdout);
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

/**
 * The HarmonyOS open post-check: a successful `aa start` dispatch says the launch was accepted,
 * not that the app is visible. When the launched bundle never holds the foreground, `open
 * --foreground` fails this open and a plain open carries the read beside its warning.
 */
export async function verifyHarmonyOpenForeground(
  input: OpenApplicationInput,
  outcome: OpenApplicationOutcome,
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<OpenApplicationOutcome> {
  const bundleId = outcome.appBundleId ?? input.appBundleId;
  if (bundleId === undefined || isDeepLinkTarget(bundleId)) return outcome;
  const read = await pollHarmonyOpenForeground(device, bundleId, { signal });
  if (read.confirmed) return outcome;
  if (input.execution.foreground === true) {
    throw new AppError(
      'COMMAND_FAILED',
      `The launch dispatch for ${bundleId} succeeded, but HarmonyOS did not show it in the foreground within 5s`,
      {
        reason: 'open-not-foreground',
        hint: 'Unlock the device screen, then run the open again.',
        ...(read.foregroundPackage === undefined
          ? {}
          : { foregroundPackage: read.foregroundPackage }),
      },
    );
  }
  return { ...outcome, timing: { ...outcome.timing, foregroundVerification: read } };
}

export async function closeHarmonyApp(device: DeviceInfo, bundleId: string): Promise<void> {
  await runHarmonyShell(device, ['aa', 'force-stop', bundleId]);
  invalidateHarmonyGestureViewport(device);
}
