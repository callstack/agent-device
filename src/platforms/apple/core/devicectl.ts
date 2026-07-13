import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DeviceInfo } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import { execFailureDetails } from '../../../utils/exec.ts';

import { IOS_DEVICECTL_TIMEOUT_MS } from './config.ts';
import { runXcrun } from './tool-provider.ts';
import type { IosAppInfo } from './app-info.ts';
import { filterAppleAppsByBundlePrefix } from './app-filter.ts';

type IosDeviceAppsPayload = {
  result?: {
    apps?: Array<{
      bundleIdentifier?: unknown;
      name?: unknown;
      url?: unknown;
    }>;
  };
};

export type IosDeviceProcessInfo = {
  executable: string;
  pid: number;
};

type IosDeviceProcessesPayload = {
  result?: {
    runningProcesses?: Array<{
      executable?: unknown;
      processIdentifier?: unknown;
    }>;
  };
};

export async function runIosDevicectl(
  args: string[],
  context: { action: string; deviceId: string },
  options: {
    timeoutMs?: number;
    /**
     * Treat a non-zero exit as success when its output matches — e.g. an
     * uninstall of an app that is already gone.
     */
    tolerateOutput?: (stdout: string, stderr: string) => boolean;
  } = {},
): Promise<void> {
  const fullArgs = ['devicectl', ...args];
  const result = await runXcrun(fullArgs, {
    allowFailure: true,
    timeoutMs: options.timeoutMs ?? IOS_DEVICECTL_TIMEOUT_MS,
  });
  if (result.exitCode === 0) return;
  const { stdout, stderr } = result;
  if (options.tolerateOutput?.(stdout, stderr)) return;
  throw new AppError(
    'COMMAND_FAILED',
    `Failed to ${context.action}`,
    execFailureDetails(result, {
      cmd: 'xcrun',
      args: fullArgs,
      stdout,
      stderr,
      deviceId: context.deviceId,
      hint: resolveIosDevicectlHint(stdout, stderr) ?? IOS_DEVICECTL_DEFAULT_HINT,
    }),
  );
}

export async function listIosDeviceApps(
  device: DeviceInfo,
  filter: 'user-installed' | 'all',
): Promise<IosAppInfo[]> {
  const payload = await runIosDevicectlJsonCommand(device, {
    jsonPrefix: 'agent-device-ios-apps',
    args: ['devicectl', 'device', 'info', 'apps', '--device', device.id, '--include-all-apps'],
    failureMessage: 'Failed to list iOS apps',
    parseFailureMessage: 'Failed to parse iOS apps list',
  });
  return filterIosDeviceApps(parseIosDeviceAppsPayload(payload), filter);
}

export async function listIosDeviceProcesses(device: DeviceInfo): Promise<IosDeviceProcessInfo[]> {
  const payload = await runIosDevicectlJsonCommand(device, {
    jsonPrefix: 'agent-device-ios-processes',
    args: ['devicectl', 'device', 'info', 'processes', '--device', device.id],
    failureMessage: 'Failed to list iOS processes',
    parseFailureMessage: 'Failed to parse iOS process list',
    fallbackHint: IOS_DEVICE_PROCESS_LIST_HINT,
  });
  if (!isIosDeviceProcessesPayload(payload)) {
    throw new AppError('COMMAND_FAILED', 'Unsupported iOS process list response', {
      deviceId: device.id,
      hint: IOS_DEVICE_PROCESS_LIST_HINT,
    });
  }
  return parseIosDeviceProcessesPayload(payload);
}

export async function terminateIosDeviceApp(device: DeviceInfo, bundleId: string): Promise<void> {
  const process = await resolveIosDeviceAppProcess(device, bundleId);
  if (!process) return;

  await runIosDevicectl(
    ['device', 'process', 'terminate', '--device', device.id, '--pid', String(process.pid)],
    {
      action: 'terminate iOS app',
      deviceId: device.id,
    },
  );
}

async function resolveIosDeviceAppProcess(
  device: DeviceInfo,
  bundleId: string,
): Promise<IosDeviceProcessInfo | undefined> {
  const app = (await listIosDeviceApps(device, 'all')).find(
    (candidate) => candidate.bundleId === bundleId,
  );
  if (!app) {
    throw new AppError('APP_NOT_INSTALLED', `No iOS device app found for ${bundleId}`, {
      appBundleId: bundleId,
      deviceId: device.id,
    });
  }
  if (!app.url) {
    throw new AppError('COMMAND_FAILED', `Cannot resolve the process ID for ${bundleId}`, {
      appBundleId: bundleId,
      deviceId: device.id,
      hint: 'Installed-app metadata from devicectl did not include a bundle URL, so agent-device cannot map this app to the PID required for termination. Use an Xcode/CoreDevice toolchain that reports app URLs, or close the app manually.',
    });
  }

  const appBundleUrl = app.url.replace(/\/+$/, '');
  const matches = (await listIosDeviceProcesses(device)).filter((process) =>
    process.executable.startsWith(`${appBundleUrl}/`),
  );
  return matches.sort(
    (left, right) => processPathDepth(left, appBundleUrl) - processPathDepth(right, appBundleUrl),
  )[0];
}

async function runIosDevicectlJsonCommand(
  device: DeviceInfo,
  options: {
    jsonPrefix: string;
    args: string[];
    failureMessage: string;
    parseFailureMessage: string;
    fallbackHint?: string;
  },
): Promise<unknown> {
  const jsonPath = path.join(
    os.tmpdir(),
    `${options.jsonPrefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  const args = [...options.args, '--json-output', jsonPath];
  const result = await runXcrun(args, {
    allowFailure: true,
    timeoutMs: IOS_DEVICECTL_TIMEOUT_MS,
  });

  try {
    if (result.exitCode !== 0) {
      const { stdout, stderr } = result;
      throw new AppError(
        'COMMAND_FAILED',
        options.failureMessage,
        execFailureDetails(result, {
          cmd: 'xcrun',
          args,
          stdout,
          stderr,
          deviceId: device.id,
          hint:
            resolveIosDevicectlHint(stdout, stderr) ??
            options.fallbackHint ??
            IOS_DEVICECTL_DEFAULT_HINT,
        }),
      );
    }
    return JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('COMMAND_FAILED', options.parseFailureMessage, {
      deviceId: device.id,
      cause: String(error),
    });
  } finally {
    await fs.unlink(jsonPath).catch(() => {});
  }
}

function processPathDepth(process: IosDeviceProcessInfo, appBundleUrl: string): number {
  return process.executable.slice(appBundleUrl.length + 1).split('/').length;
}

function isIosDeviceProcessesPayload(payload: unknown): payload is IosDeviceProcessesPayload {
  return Array.isArray(
    (payload as IosDeviceProcessesPayload | null | undefined)?.result?.runningProcesses,
  );
}

export function parseIosDeviceAppsPayload(payload: unknown): IosAppInfo[] {
  const apps = (payload as IosDeviceAppsPayload | null | undefined)?.result?.apps;
  if (!Array.isArray(apps)) return [];

  const parsed: IosAppInfo[] = [];
  for (const entry of apps) {
    if (!entry || typeof entry !== 'object') continue;
    const bundleId =
      typeof entry.bundleIdentifier === 'string' ? entry.bundleIdentifier.trim() : '';
    if (!bundleId) continue;
    const name =
      typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : bundleId;
    const url =
      typeof entry.url === 'string' && entry.url.trim().length > 0 ? entry.url.trim() : undefined;
    parsed.push({ bundleId, name, url });
  }
  return parsed;
}

export function parseIosDeviceProcessesPayload(payload: unknown): IosDeviceProcessInfo[] {
  const processes = (payload as IosDeviceProcessesPayload | null | undefined)?.result
    ?.runningProcesses;
  if (!Array.isArray(processes)) return [];

  const parsed: IosDeviceProcessInfo[] = [];
  for (const entry of processes) {
    if (!entry || typeof entry !== 'object') continue;
    const executable = typeof entry.executable === 'string' ? entry.executable.trim() : '';
    const pid =
      typeof entry.processIdentifier === 'number' && Number.isFinite(entry.processIdentifier)
        ? entry.processIdentifier
        : NaN;
    if (!executable || !Number.isFinite(pid)) continue;
    parsed.push({ executable, pid });
  }
  return parsed;
}

function filterIosDeviceApps(apps: IosAppInfo[], filter: 'user-installed' | 'all'): IosAppInfo[] {
  return filterAppleAppsByBundlePrefix(apps, filter);
}

export const IOS_DEVICECTL_DEFAULT_HINT =
  'Ensure the iOS device is unlocked, trusted, and available in Xcode > Devices, then retry.';

const IOS_DEVICE_PROCESS_LIST_HINT =
  "This Xcode/CoreDevice toolchain must support 'devicectl device info processes' with JSON runningProcesses so agent-device can resolve app process IDs. Inspect diagnostics for the exact devicectl API failure.";

export function resolveIosDevicectlHint(stdout: string, stderr: string): string | null {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (text.includes('device is busy') && text.includes('connecting')) {
    return 'iOS device is still connecting. Keep it unlocked and connected by cable until it is fully available in Xcode Devices, then retry.';
  }
  if (text.includes('coredeviceservice') && text.includes('timed out')) {
    return 'CoreDevice service timed out. Reconnect the device and retry; if it persists restart Xcode and the iOS device.';
  }
  return null;
}
