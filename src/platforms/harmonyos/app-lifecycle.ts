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
  hapModuleInfos?: Array<{
    mainElementName?: string;
    moduleName?: string;
  }>;
}

interface HarmonyArchiveModule {
  app?: { bundleName?: string };
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
  const jsonStart = rawOutput.indexOf('{');
  if (jsonStart === -1) return undefined;
  let dump: HarmonyBundleDump;
  try {
    dump = JSON.parse(rawOutput.slice(jsonStart)) as HarmonyBundleDump;
  } catch {
    return undefined;
  }
  const module = dump.hapModuleInfos?.find((item) => item.mainElementName);
  if (!module?.mainElementName) return undefined;
  return { ability: module.mainElementName, module: module.moduleName };
}

export async function listHarmonyApps(
  device: DeviceInfo,
  _filter: 'all' | 'user-installed',
): Promise<Array<{ package: string; name: string }>> {
  const result = await runHarmonyHdc(device, ['shell', 'bm', 'dump', '-a'], { timeoutMs: 15_000 });
  return parseHarmonyBundleList(result.stdout).map((pkg) => ({
    package: pkg,
    name: pkg.split('.').at(-1) ?? pkg,
  }));
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
