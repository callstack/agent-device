import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '../../utils/exec.ts';
import { sleep } from '../../utils/timeouts.ts';
import { runHarmonyHdc } from './hdc.ts';

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
  applicationInfo?: {
    isSystemApp?: boolean;
  };
  appInfo?: {
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
): Promise<string | undefined> {
  const result = await runCmd('unzip', ['-p', archivePath, 'module.json'], {
    allowFailure: true,
    timeoutMs: 15_000,
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
    const result = await runHarmonyHdc(device, ['shell', 'bm', 'dump', '-a'], {
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
    const result = await runHarmonyHdc(device, ['shell', 'bm', 'dump', '-a'], {
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
        const result = await runHarmonyHdc(device, ['shell', 'bm', 'dump', '-n', bundleName], {
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

export async function openHarmonyApp(
  device: DeviceInfo,
  bundleId: string,
  options?: { activity?: string },
): Promise<void> {
  const launchTarget = options?.activity
    ? { ability: options.activity }
    : parseHarmonyLaunchTarget(
        (
          await runHarmonyHdc(device, ['shell', 'bm', 'dump', '-n', bundleId], {
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
  const args = ['shell', 'aa', 'start', '-a', launchTarget.ability, '-b', bundleId];
  if (launchTarget.module) args.push('-m', launchTarget.module);
  const result = await runHarmonyHdc(device, args);
  if (!result.stdout.includes('start ability successfully')) {
    throw new AppError('COMMAND_FAILED', `Failed to start ${bundleId}`, {
      details: { output: result.stdout.trim() },
    });
  }
}

export async function closeHarmonyApp(device: DeviceInfo, bundleId: string): Promise<void> {
  await runHarmonyHdc(device, ['shell', 'aa', 'force-stop', bundleId]);
}

export async function installHarmonyApp(
  device: DeviceInfo,
  archivePath: string,
  options: { bundleIdHint?: string; relaunch?: boolean } = {},
): Promise<{ package: string; launchTarget: string }> {
  const bundleName = (await resolveHarmonyArchiveBundleName(archivePath)) ?? options.bundleIdHint;
  if (!bundleName) {
    throw new AppError('INVALID_ARGS', 'Could not determine the bundle name from the HAP archive', {
      hint: 'Pass the HarmonyOS bundle name before the HAP path, or provide a valid HAP containing module.json.',
    });
  }
  await runHarmonyHdc(device, ['install', '-r', archivePath], { timeoutMs: 180_000 });
  if (options.relaunch) {
    // HDC returns after transfer, while physical devices can still be replacing
    // the running bundle. Starting immediately is acknowledged but may not put
    // the new ability in front; API 24 devices reliably settle within one second.
    await sleep(1_000);
    await openHarmonyApp(device, bundleName);
  }
  return { package: bundleName, launchTarget: bundleName };
}
