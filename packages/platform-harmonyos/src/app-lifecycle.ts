import { setTimeout as sleep } from 'node:timers/promises';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ShellWord } from '@agent-device/kernel/device-shell';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type {
  OpenApplicationInput,
  OpenApplicationOutcome,
  OpenForegroundVerification,
} from '@agent-device/contracts/application-lifecycle-runtime';
import { isDeepLinkTarget } from '@agent-device/contracts/command';
import { runHarmonyShell } from './hdc.ts';
import { parseHarmonyForegroundRead } from './app-state.ts';
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

const HARMONY_APP_INVENTORY_TIMEOUT_MS = 60_000;
const HARMONY_APP_METADATA_CONCURRENCY = 4;

interface HarmonyAppListOptions {
  signal?: AbortSignal;
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

/** Why a HarmonyOS app-open argument is refused before any device is touched. */
const HARMONY_LIFECYCLE_REFUSAL_REASONS = {
  // --activity is not an ability name the module.json5 format can carry.
  invalidAbilityName: { reason: 'invalid-harmony-ability-name' },
} as const satisfies ReasonTable<'open'>;

function requireHarmonyAbilityName(ability: string): void {
  if (HARMONY_ABILITY_NAME.test(ability)) return;
  throw new AppError('INVALID_ARGS', `Invalid HarmonyOS ability name: ${ability}`, {
    reason: HARMONY_LIFECYCLE_REFUSAL_REASONS.invalidAbilityName.reason,
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

/** One `aa dump -l` read; a read never outlives the poll's own budget remainder. */
const HARMONY_OPEN_FOREGROUND_READ_TIMEOUT_MS = 5_000;

/**
 * Reads which HarmonyOS mission holds the foreground until the launched bundle does, the poll
 * budget runs out, or the request is aborted. Answers the contract's verification fact when the
 * budget closed unconfirmed, and `undefined` when the launched bundle held the foreground.
 */
export async function pollHarmonyOpenForeground(
  device: DeviceInfo,
  bundleId: string,
  options: Readonly<{
    signal?: AbortSignal;
    pollBudgetMs?: number;
    pollIntervalMs?: number;
  }> = {},
): Promise<OpenForegroundVerification | undefined> {
  const pollBudgetMs = options.pollBudgetMs ?? HARMONY_OPEN_FOREGROUND_POLL_BUDGET_MS;
  const pollIntervalMs = options.pollIntervalMs ?? HARMONY_OPEN_FOREGROUND_POLL_INTERVAL_MS;
  const deadlineAtMs = Date.now() + pollBudgetMs;
  let foregroundPackage: string | undefined;
  let sawReadable = false;
  while (true) {
    options.signal?.throwIfAborted();
    // Each read is bounded by the budget's remainder, so one slow read cannot
    // push the poll past its deadline.
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) break;
    const missionRead = await readHarmonyForegroundMission(
      device,
      options.signal,
      Math.min(remainingMs, HARMONY_OPEN_FOREGROUND_READ_TIMEOUT_MS),
    );
    if (missionRead.kind === 'foreground') {
      sawReadable = true;
      if (missionRead.package === bundleId) return undefined;
      foregroundPackage = missionRead.package;
    } else if (missionRead.kind === 'no-foreground-mission') {
      // A read that answered with no FOREGROUND mission is the lock-screen
      // shape: evidence the app stayed behind a system surface, not a probe
      // that failed to run.
      sawReadable = true;
    }
    const remainingAfterRead = deadlineAtMs - Date.now();
    if (remainingAfterRead <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingAfterRead), undefined, {
      signal: options.signal,
    });
  }
  if (!sawReadable) return { state: 'probe-failed' };
  if (foregroundPackage !== undefined) {
    return { state: 'other-foreground', foregroundPackage };
  }
  return { state: 'no-foreground' };
}

/**
 * One foreground read. `no-foreground-mission` is the lock-screen shape; `failed` is a read that
 * threw, timed out, or produced output with no parseable mission list.
 */
type HarmonyForegroundMissionRead =
  | { kind: 'foreground'; package: string }
  | { kind: 'no-foreground-mission' }
  | { kind: 'failed' };

async function readHarmonyForegroundMission(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<HarmonyForegroundMissionRead> {
  try {
    const result = await runHarmonyShell(device, ['aa', 'dump', '-l'], {
      signal,
      timeoutMs,
    });
    const parse = parseHarmonyForegroundRead(result.stdout);
    if (parse.kind === 'foreground') return { kind: 'foreground', package: parse.package };
    return parse.kind === 'no-foreground-mission'
      ? { kind: 'no-foreground-mission' }
      : { kind: 'failed' };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: 'failed' };
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
  // The poll never outlives the request's own deadline: whatever the budget
  // has less room for wins, and a budget with no room for one read falls to
  // probe-failed. A clamped budget names the deadline instead of the 5s
  // default, so the message never claims a window the request did not have.
  const requestDeadlineAtMs = input.execution.requestDeadlineAtMs;
  const clampedByDeadline = requestDeadlineAtMs !== undefined;
  const pollBudgetMs =
    requestDeadlineAtMs === undefined
      ? HARMONY_OPEN_FOREGROUND_POLL_BUDGET_MS
      : Math.min(
          HARMONY_OPEN_FOREGROUND_POLL_BUDGET_MS,
          Math.max(0, requestDeadlineAtMs - Date.now()),
        );
  const verification = await pollHarmonyOpenForeground(device, bundleId, { signal, pollBudgetMs });
  if (verification === undefined) return outcome;
  if (input.execution.foreground !== true) {
    return { ...outcome, timing: { ...outcome.timing, foregroundVerification: verification } };
  }
  throw openForegroundHardFailure(bundleId, verification, clampedByDeadline);
}

/**
 * The `--foreground` hard failure: a probe whose every read failed is a probe
 * that never ran to an answer, so it carries the unreadable reason and the
 * connection hint; an answered read that never named the launched app carries
 * `open-not-foreground` and the unlock hint.
 */
function openForegroundHardFailure(
  bundleId: string,
  verification: OpenForegroundVerification,
  clampedByDeadline: boolean,
): AppError {
  if (verification.state === 'probe-failed') {
    return new AppError(
      'COMMAND_FAILED',
      clampedByDeadline
        ? `The launch dispatch for ${bundleId} succeeded, but the request deadline passed before the foreground probe could read the device`
        : `The launch dispatch for ${bundleId} succeeded, but the foreground probe could not read the device within 5s`,
      {
        reason: 'open-foreground-probe-unreadable',
        hint: clampedByDeadline
          ? 'The request deadline is too tight for a foreground read: run the open again with more budget.'
          : 'Check the device connection, then run the open again.',
      },
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    clampedByDeadline
      ? `The launch dispatch for ${bundleId} succeeded, but HarmonyOS did not show it in the foreground before the request deadline`
      : `The launch dispatch for ${bundleId} succeeded, but HarmonyOS did not show it in the foreground within 5s`,
    {
      reason: 'open-not-foreground',
      hint: 'Unlock the device screen, then run the open again.',
      ...(verification.state === 'other-foreground'
        ? { foregroundPackage: verification.foregroundPackage }
        : {}),
    },
  );
}

export async function closeHarmonyApp(device: DeviceInfo, bundleId: string): Promise<void> {
  await runHarmonyShell(device, ['aa', 'force-stop', bundleId]);
  invalidateHarmonyGestureViewport(device);
}
