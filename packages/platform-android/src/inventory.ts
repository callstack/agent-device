import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, asAppError } from '@agent-device/kernel/errors';
import type {
  DeviceInventoryHostFor,
  HostCommandResult,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInventorySource } from '@agent-device/contracts/platform-module';
import type { DeviceInventoryRequest } from '@agent-device/contracts/device';
import { androidDiscoveryCommandError, attachAndroidDiscoveryTimeout } from './adb-failure.ts';
import type { AndroidInventoryConfig } from './inventory-config.ts';
import {
  inferAndroidAvdTarget,
  isAndroidEmulatorSerial,
  normalizeAndroidDeviceName,
  parseAndroidAvdList,
  parseAndroidDeviceEntries,
  parseAndroidEmulatorAvdNameOutput,
  parseAndroidFeatureListForTv,
  parseAndroidTargetFromCharacteristics,
  type AndroidDeviceEntry,
} from './inventory-parsers.ts';

const PROBE_TIMEOUT_MS = 10_000;
const TV_FEATURES = [
  'android.software.leanback',
  'android.software.leanback_only',
  'android.hardware.type.television',
] as const;

type AndroidInventoryContext = Readonly<{
  host: DeviceInventoryHostFor<'android'>;
  adb: string;
  emulator?: string;
  scope: PlatformRequestScope;
}>;

export function createAndroidInventory(
  host: DeviceInventoryHostFor<'android'>,
  config: AndroidInventoryConfig = { sdkRoots: [] },
): DeviceInventorySource {
  return {
    discover: async (request, scope) => await discoverAndroidDevices(host, config, request, scope),
  };
}

async function discoverAndroidDevices(
  host: DeviceInventoryHostFor<'android'>,
  config: AndroidInventoryConfig,
  request: Readonly<DeviceInventoryRequest>,
  scope: PlatformRequestScope,
): Promise<readonly DeviceInfo[]> {
  await host.toolchains.prepare('android');
  const sdkRoots = [...config.sdkRoots, path.join(host.homeDirectory, 'Android', 'Sdk')];
  const adb = await resolveTool(host, 'adb', sdkRoots, ['platform-tools', 'adb']);
  if (!adb) throw new AppError('TOOL_MISSING', 'adb not found in PATH');
  const emulator = await resolveTool(host, 'emulator', sdkRoots, ['emulator', 'emulator']);
  const context: AndroidInventoryContext = {
    host,
    adb,
    emulator,
    scope,
  };
  const allowlist = resolveSerialAllowlist(request);
  const entries = (await listDeviceEntries(context)).filter(
    (entry) => !allowlist || allowlist.has(entry.serial),
  );
  const running = await mapWithConcurrency(
    entries,
    3,
    async (entry) => await probeRunningDevice(context, entry),
  );
  return [
    ...running,
    ...(request.androidAvdSelection === 'running-only'
      ? []
      : await listStoppedAvds(context, running)),
  ];
}

function resolveSerialAllowlist(
  request: Readonly<DeviceInventoryRequest>,
): ReadonlySet<string> | undefined {
  const selected = request.serial?.trim();
  const policy = request.androidSerialAllowlist;
  if (!selected) return policy ? new Set(policy) : undefined;
  if (!policy) return new Set([selected]);
  return new Set(policy.includes(selected) ? [selected] : []);
}

async function resolveTool(
  host: DeviceInventoryHostFor<'android'>,
  executable: string,
  sdkRoots: readonly string[],
  relativeSegments: readonly string[],
): Promise<string | undefined> {
  for (const sdkRoot of sdkRoots) {
    const candidate = path.join(sdkRoot, ...relativeSegments);
    if (await host.files.isExecutable(candidate)) return candidate;
  }
  return await host.commands.which(executable);
}

async function listDeviceEntries(context: AndroidInventoryContext): Promise<AndroidDeviceEntry[]> {
  const result = await run(context, context.adb, ['devices', '-l']);
  if (result.exitCode !== 0) {
    throw androidDiscoveryCommandError(
      'Failed to list Android devices',
      result,
      'Verify adb is running and the device appears in `adb devices`.',
    );
  }
  return parseAndroidDeviceEntries(result.stdout);
}

async function probeRunningDevice(
  context: AndroidInventoryContext,
  entry: AndroidDeviceEntry,
): Promise<DeviceInfo> {
  const [name, booted, target] = await Promise.all([
    resolveDeviceName(context, entry),
    isBooted(context, entry.serial),
    resolveTarget(context, entry.serial),
  ]);
  return {
    platform: 'android',
    id: entry.serial,
    name,
    kind: isAndroidEmulatorSerial(entry.serial) ? 'emulator' : 'device',
    target,
    booted,
  };
}

async function resolveDeviceName(
  context: AndroidInventoryContext,
  entry: AndroidDeviceEntry,
): Promise<string> {
  const model = entry.rawModel.replaceAll('_', ' ').trim();
  if (!isAndroidEmulatorSerial(entry.serial)) return model || entry.serial;
  const avdName = await resolveEmulatorAvdName(context, entry.serial);
  return avdName?.replaceAll('_', ' ') || model || entry.serial;
}

async function resolveEmulatorAvdName(
  context: AndroidInventoryContext,
  serial: string,
): Promise<string | undefined> {
  for (const prop of ['ro.boot.qemu.avd_name', 'persist.sys.avd_name']) {
    const result = await runBestEffortNameProbe(context, serial, ['shell', 'getprop', prop]);
    const value = result?.stdout.trim();
    if (result?.exitCode === 0 && value) return value;
  }
  const result = await runBestEffortNameProbe(context, serial, ['emu', 'avd', 'name']);
  const value = result && parseAndroidEmulatorAvdNameOutput(result.stdout);
  return result?.exitCode === 0 ? value : undefined;
}

async function runBestEffortNameProbe(
  context: AndroidInventoryContext,
  serial: string,
  args: string[],
): Promise<HostCommandResult | undefined> {
  try {
    return await runAdb(context, serial, args);
  } catch (error) {
    const appError = asAppError(error);
    if (appError.code === 'COMMAND_FAILED' && typeof appError.details?.timeoutMs === 'number') {
      return undefined;
    }
    throw error;
  }
}

async function isBooted(context: AndroidInventoryContext, serial: string): Promise<boolean> {
  try {
    return (
      (await runAdb(context, serial, ['shell', 'getprop', 'sys.boot_completed'])).stdout.trim() ===
      '1'
    );
  } catch (error) {
    if (context.scope.signal.aborted) throw error;
    return false;
  }
}

async function resolveTarget(
  context: AndroidInventoryContext,
  serial: string,
): Promise<'mobile' | 'tv'> {
  const characteristics = await runAdb(context, serial, [
    'shell',
    'getprop',
    'ro.build.characteristics',
  ]);
  if (parseAndroidTargetFromCharacteristics(commandOutput(characteristics)) === 'tv') return 'tv';
  const featureResults = await mapWithConcurrency(
    TV_FEATURES,
    2,
    async (feature) =>
      await runAdb(context, serial, ['shell', 'cmd', 'package', 'has-feature', feature]),
  );
  if (featureResults.some((result) => commandOutput(result).toLowerCase().includes('true'))) {
    return 'tv';
  }
  const featureList = await runAdb(context, serial, ['shell', 'pm', 'list', 'features']);
  return parseAndroidFeatureListForTv(commandOutput(featureList)) ? 'tv' : 'mobile';
}

async function listStoppedAvds(
  context: AndroidInventoryContext,
  running: readonly DeviceInfo[],
): Promise<DeviceInfo[]> {
  if (!context.emulator) return [];
  let result: HostCommandResult;
  try {
    result = await run(context, context.emulator, ['-list-avds']);
  } catch (error) {
    if (context.scope.signal.aborted) throw error;
    return [];
  }
  if (result.exitCode !== 0) return [];
  const runningNames = new Set(
    running
      .filter((device) => device.kind === 'emulator')
      .map((device) => normalizeAndroidDeviceName(device.name)),
  );
  return parseAndroidAvdList(result.stdout)
    .filter((name) => !runningNames.has(normalizeAndroidDeviceName(name)))
    .map((name) => ({
      platform: 'android',
      id: name,
      name,
      kind: 'emulator',
      target: inferAndroidAvdTarget(name),
      booted: false,
    }));
}

async function runAdb(
  context: AndroidInventoryContext,
  serial: string,
  args: string[],
): Promise<HostCommandResult> {
  return await run(context, context.adb, ['-s', serial, ...args]);
}

async function run(
  context: AndroidInventoryContext,
  executable: string,
  args: readonly string[],
): Promise<HostCommandResult> {
  try {
    return await context.host.commands.run(
      {
        executable,
        args,
        allowFailure: true,
        timeoutMs: PROBE_TIMEOUT_MS,
      },
      context.scope.signal,
    );
  } catch (error) {
    throw attachAndroidDiscoveryTimeout(error);
  }
}

function commandOutput(result: HostCommandResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await mapper(values[index]!);
      }
    }),
  );
  return results;
}
