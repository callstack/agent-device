import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { requireExecSuccess, type ExecResult } from '@agent-device/host-kit/command';
import { splitNonEmptyTrimmedLines } from '@agent-device/kernel/record';
import type { IosDeviceProcessInfo } from './app-info.ts';
import { resolveIosPhysicalDeviceControl } from './physical-device-control.ts';
import { readInfoPlistString } from './plist.ts';
import { buildSimctlArgsForDevice } from './simctl.ts';
import { runAppleToolCommand, runXcrun } from './tool-provider.ts';

const APPLE_PERF_TIMEOUT_MS = 15_000;

export type AppleProcessSample = {
  pid: number;
  cpuPercent: number;
  rssKb: number;
  command: string;
};

export function parseApplePsOutput(stdout: string): AppleProcessSample[] {
  const rows: AppleProcessSample[] = [];
  for (const line of splitNonEmptyTrimmedLines(stdout)) {
    const match = line.match(/^(\d+)\s+([0-9]+(?:\.[0-9]+)?)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const [pidText, cpuText, rssText, commandText] = match.slice(1);
    if (
      pidText === undefined ||
      cpuText === undefined ||
      rssText === undefined ||
      commandText === undefined
    ) {
      continue;
    }
    const pid = Number(pidText);
    const cpuPercent = Number(cpuText);
    const rssKb = Number(rssText);
    const command = commandText.trim();
    if (!Number.isFinite(pid) || !Number.isFinite(cpuPercent) || !Number.isFinite(rssKb)) {
      continue;
    }
    rows.push({ pid, cpuPercent, rssKb, command });
  }
  return rows;
}

export async function resolveAppleExecutable(
  device: DeviceInfo,
  appBundleId: string,
): Promise<{ executableName: string; executablePath?: string }> {
  const appPath = isMacOs(device)
    ? await resolveMacOsBundlePath(appBundleId)
    : await resolveIosSimulatorAppContainer(device, appBundleId);
  const infoPlistPath = isMacOs(device)
    ? path.join(appPath, 'Contents', 'Info.plist')
    : path.join(appPath, 'Info.plist');
  const executableName = await readInfoPlistString(infoPlistPath, 'CFBundleExecutable');
  if (!executableName) {
    throw new AppError('COMMAND_FAILED', `Failed to resolve executable for ${appBundleId}`, {
      appBundleId,
      appPath,
    });
  }

  return {
    executableName,
    executablePath: isMacOs(device)
      ? path.join(appPath, 'Contents', 'MacOS', executableName)
      : path.join(appPath, executableName),
  };
}

export async function resolveIosDevicePerfTarget(
  device: DeviceInfo,
  appBundleId: string,
): Promise<IosDeviceProcessInfo[]> {
  const { appBundleUrl, processes } = await resolveIosPhysicalDeviceControl(
    device,
  ).resolveAppProcesses(device, appBundleId);
  const appBundlePath = fileURLToPath(appBundleUrl);
  if (processes.length === 0) {
    throw new AppError('COMMAND_FAILED', `No running process found for ${appBundleId}`, {
      appBundleId,
      deviceId: device.id,
      appBundlePath,
      hint: 'Run open <app> for this session again to ensure the iOS app is active, then retry perf.',
    });
  }

  return processes;
}

async function resolveMacOsBundlePath(appBundleId: string): Promise<string> {
  const query = `kMDItemCFBundleIdentifier == "${appBundleId.replaceAll('"', String.raw`\"`)}"`;
  const result = requireExecSuccess(
    await runAppleToolCommand('mdfind', [query], {
      allowFailure: true,
      timeoutMs: APPLE_PERF_TIMEOUT_MS,
    }),
    `Failed to resolve macOS app bundle for ${appBundleId}`,
    { appBundleId },
  );

  const bundlePath = result.stdout
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.endsWith('.app'));
  if (!bundlePath) {
    throw new AppError('APP_NOT_INSTALLED', `No macOS app found for ${appBundleId}`, {
      appBundleId,
    });
  }
  return bundlePath;
}

async function resolveIosSimulatorAppContainer(
  device: DeviceInfo,
  appBundleId: string,
): Promise<string> {
  const args = buildSimctlArgsForDevice(device, [
    'get_app_container',
    device.id,
    appBundleId,
    'app',
  ]);
  const result = requireExecSuccess(
    await runXcrun(args, {
      allowFailure: true,
      timeoutMs: APPLE_PERF_TIMEOUT_MS,
    }),
    `Failed to resolve iOS simulator app container for ${appBundleId}`,
    {
      appBundleId,
      hint: 'Ensure the iOS simulator app is installed and booted, then retry perf.',
    },
  );
  const appPath = result.stdout.trim();
  if (appPath.length === 0) {
    throw new AppError(
      'APP_NOT_INSTALLED',
      `No iOS simulator app container found for ${appBundleId}`,
      {
        appBundleId,
      },
    );
  }
  return appPath;
}

export async function readAppleProcessSamples(
  device: DeviceInfo,
  executable: { executableName: string; executablePath?: string },
): Promise<AppleProcessSample[]> {
  const args = isMacOs(device)
    ? ['-axo', 'pid=,%cpu=,rss=,command=']
    : buildSimctlArgsForDevice(device, [
        'spawn',
        device.id,
        'ps',
        '-axo',
        'pid=,%cpu=,rss=,command=',
      ]);
  const result = isMacOs(device)
    ? await runAppleToolCommand('ps', args, { timeoutMs: APPLE_PERF_TIMEOUT_MS })
    : await runAppleSimulatorProcessCommand(args);
  const { matchesAppleExecutableProcess } = await import('./perf-process-identity.ts');
  return parseApplePsOutput(result.stdout).filter((processInfo) =>
    matchesAppleExecutableProcess(processInfo.command, executable),
  );
}

async function runAppleSimulatorProcessCommand(args: string[]): Promise<ExecResult> {
  const result = await runXcrun(args, {
    allowFailure: true,
    timeoutMs: APPLE_PERF_TIMEOUT_MS,
  });
  if (result.exitCode === 0) return result;
  return await runAppleToolCommand('ps', ['-axo', 'pid=,%cpu=,rss=,command='], {
    timeoutMs: APPLE_PERF_TIMEOUT_MS,
  });
}
