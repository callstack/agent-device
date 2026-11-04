import { readSimctlContainerPath, scopeSimctlArgsForDevice } from './simctl.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostFileStat } from '@agent-device/host-kit/host-file';
import { isCommandTimeoutError } from '@agent-device/host-kit/command';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { createTtlMemo } from '@agent-device/kernel/ttl-memo';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { remainingLookupBudget } from './simulator-app-budget.ts';
import type {
  AppleSimulatorAppInfoRequest,
  AppleSimctlToolProvider,
  AppleToolCommandExecutor,
  SimulatorAppListOptions,
  SimulatorAppListRead,
} from './tool-provider-types.ts';

type SimulatorAppListRecord = Record<
  string,
  {
    ApplicationType?: string;
    Bundle?: string;
    CFBundleDisplayName?: string;
    CFBundleName?: string;
    Path?: string;
  }
>;

export async function readSimulatorAppMetadata(
  tools: { simctl: AppleSimctlToolProvider; runCommand: AppleToolCommandExecutor },
  device: DeviceInfo,
  options?: SimulatorAppListOptions,
): Promise<SimulatorAppListRead> {
  const remaining = remainingLookupBudget(options ?? {});
  const result = await tools.simctl.run(scopeSimctlArgsForDevice(device, ['listapps', device.id]), {
    allowFailure: true,
    ...remaining(),
  });
  const unreadable = {
    type: 'unreadable',
    exitCode: result.exitCode,
    stderr: String(result.stderr ?? ''),
  } as const;
  const trimmed = (result.stdout as string).trim();
  if (!trimmed.startsWith('{')) return unreadable;

  const parsed =
    parseSimulatorAppList(trimmed) ??
    (await convertSimulatorAppList(tools.runCommand, trimmed, remaining()));
  if (!parsed) return unreadable;
  const apps = Object.entries(parsed).map(([bundleId, info]) => {
    const appPath = resolveSimulatorAppPath(info);
    return {
      bundleId,
      name: info.CFBundleDisplayName ?? info.CFBundleName ?? bundleId,
      ...(appPath ? { path: appPath } : {}),
      ...(info.ApplicationType ? { applicationType: info.ApplicationType } : {}),
    };
  });
  return { type: 'listed', apps };
}

function parseSimulatorAppList(text: string): SimulatorAppListRecord | null {
  try {
    return JSON.parse(text) as SimulatorAppListRecord;
  } catch {
    return null;
  }
}

/**
 * `simctl listapps` prints an OpenStep plist on some Xcode versions; `plutil` converts it. A
 * timeout or abort of that conversion is the lookup's failure, not an empty app list.
 */
async function convertSimulatorAppList(
  runCommand: AppleToolCommandExecutor,
  text: string,
  options: SimulatorAppListOptions,
): Promise<SimulatorAppListRecord | null> {
  try {
    const converted = await runCommand('plutil', ['-convert', 'json', '-o', '-', '-'], {
      allowFailure: true,
      stdin: text,
      ...options,
    });
    if (converted.exitCode !== 0 || !converted.stdout.trim().startsWith('{')) return null;
    return JSON.parse(converted.stdout) as SimulatorAppListRecord;
  } catch (error) {
    if (isCommandTimeoutError(error) || isRequestCanceledError(error)) throw error;
    return null;
  }
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

// Cache only successful parses; reinstalling changes the bundle's plist mtime.
const infoPlistMemo = createTtlMemo<string, Record<string, unknown>>({
  ttlMs: 30 * 60_000,
  scheduleExpiry: true,
});

export async function readSimulatorAppInfoPlist(
  { simctl, runCommand }: { simctl: AppleSimctlToolProvider; runCommand: AppleToolCommandExecutor },
  { device, bundleId, appPath, ...options }: AppleSimulatorAppInfoRequest,
): Promise<Record<string, unknown> | null> {
  const remaining = remainingLookupBudget(options);
  if (!appPath) {
    const container = await simctl.run(
      scopeSimctlArgsForDevice(device, ['get_app_container', device.id, bundleId, 'app']),
      {
        allowFailure: true,
        ...remaining(),
      },
    );
    appPath = readSimctlContainerPath(String(container.stdout));
    if (container.exitCode !== 0 || !appPath) return null;
  }
  const infoPlistPath = path.join(appPath, 'Info.plist');
  let cacheKey: string | undefined;
  try {
    cacheKey = `${infoPlistPath}:${(await hostFileStat(infoPlistPath)).mtimeMs}`;
  } catch {
    cacheKey = undefined;
  }
  options.signal?.throwIfAborted();
  const cached = cacheKey === undefined ? undefined : infoPlistMemo.get(cacheKey);
  if (cached) return cached;
  const result = await runCommand('plutil', ['-convert', 'json', '-o', '-', infoPlistPath], {
    allowFailure: true,
    ...remaining(),
  });
  if (result.exitCode !== 0) return null;
  try {
    const plist = JSON.parse(result.stdout) as Record<string, unknown>;
    if (cacheKey !== undefined && plist) infoPlistMemo.set(cacheKey, plist);
    return plist;
  } catch {
    return null;
  }
}
