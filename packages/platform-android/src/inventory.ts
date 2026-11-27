import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceShellArgv, shellFragment, type ShellWord } from '@agent-device/kernel/device-shell';
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
  parseAndroidDeviceProps,
  parseAndroidEmulatorAvdNameOutput,
  androidFeatureListDeclares,
  parseAndroidTargetFromCharacteristics,
  ANDROID_INVENTORY_PROPS,
  type AndroidDeviceEntry,
  type AndroidDeviceProps,
} from './inventory-parsers.ts';

const PROBE_TIMEOUT_MS = 10_000;
// Every property discovery reads, one `getprop` per line in ANDROID_INVENTORY_PROPS order, in one
// adb shell: getprop reads the property area without a binder call, so a busy device answers it.
const DEVICE_PROPS_PROBE = shellFragment(
  ANDROID_INVENTORY_PROPS.map((prop) => `getprop ${prop}`).join('; '),
);
// Fire OS devices declare amazon.hardware.fire_tv and may not declare the AOSP leanback
// features, so TV detection must read it as a TV signal too (Amazon: "Identify Fire TV
// Devices", adb shell pm list features).
const TV_FEATURES = [
  'android.software.leanback',
  'android.software.leanback_only',
  'android.hardware.type.television',
  'amazon.hardware.fire_tv',
] as const;

type AndroidInventoryContext = Readonly<{
  host: DeviceInventoryHostFor<'android'>;
  adb: string;
  emulator?: string;
  /** The serial the request names; its probe failures fail discovery. */
  selectedSerial?: string;
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
  // The ~/Android/Sdk default root exists only when the host names a home; a host with no home
  // discovers from the configured roots and PATH instead of failing the whole inventory.
  const sdkRoots = [
    ...config.sdkRoots,
    ...(host.homeDirectory === undefined ? [] : [path.join(host.homeDirectory, 'Android', 'Sdk')]),
  ];
  const adb = await resolveTool(host, 'adb', sdkRoots, ['platform-tools', 'adb']);
  if (!adb) throw new AppError('TOOL_MISSING', 'adb not found in PATH');
  const emulator = await resolveTool(host, 'emulator', sdkRoots, ['emulator', 'emulator']);
  const context: AndroidInventoryContext = {
    host,
    adb,
    emulator,
    selectedSerial: request.serial?.trim() || undefined,
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

/**
 * Two adb shells per running device, run together: the getprop batch and `pm list features`. The
 * feature list stays its own call because a busy device can stall it (#4765), and a stalled
 * feature list must not take the boot state, name, or description with it.
 */
async function probeRunningDevice(
  context: AndroidInventoryContext,
  entry: AndroidDeviceEntry,
): Promise<DeviceInfo> {
  const [propsProbe, featuresProbe] = await Promise.allSettled([
    runAdbShell(context, entry.serial, [DEVICE_PROPS_PROBE]),
    runAdbShell(context, entry.serial, ['pm', 'list', 'features']),
  ]);
  const props = readDeviceProps(propsProbe);
  // The target goes first: it fails discovery on a props probe failure other than a timeout.
  const target = resolveTargetOrUnknown(context, entry.serial, () =>
    resolveTarget(propsProbe, props, featuresProbe),
  );
  const name = await resolveDeviceName(context, entry, props);
  return {
    platform: 'android',
    id: entry.serial,
    name,
    kind: isAndroidEmulatorSerial(entry.serial) ? 'emulator' : 'device',
    target,
    ...(props?.['ro.product.model'] ? { model: props['ro.product.model'] } : {}),
    ...(props?.['ro.build.version.release']
      ? { osVersion: props['ro.build.version.release'] }
      : {}),
    booted: props?.['sys.boot_completed'] === '1',
  };
}

/** The properties a device answered, `{}` when adb exited non-zero, `undefined` when it failed. */
function readDeviceProps(
  probe: PromiseSettledResult<HostCommandResult>,
): AndroidDeviceProps | undefined {
  if (probe.status === 'rejected') return undefined;
  return probe.value.exitCode === 0 ? parseAndroidDeviceProps(probe.value.stdout) : {};
}

async function resolveDeviceName(
  context: AndroidInventoryContext,
  entry: AndroidDeviceEntry,
  props: AndroidDeviceProps | undefined,
): Promise<string> {
  const model = entry.rawModel.replaceAll('_', ' ').trim();
  if (!isAndroidEmulatorSerial(entry.serial)) return model || entry.serial;
  const avdName =
    props?.['ro.boot.qemu.avd_name'] ||
    props?.['persist.sys.avd_name'] ||
    (await readEmulatorConsoleAvdName(context, entry.serial));
  return avdName?.replaceAll('_', ' ') || model || entry.serial;
}

/** Asks the emulator console, for an emulator whose properties name no AVD. */
async function readEmulatorConsoleAvdName(
  context: AndroidInventoryContext,
  serial: string,
): Promise<string | undefined> {
  let result: HostCommandResult;
  try {
    result = await run(context, context.adb, ['-s', serial, 'emu', 'avd', 'name']);
  } catch (error) {
    if (isAdbTimeout(error)) return undefined;
    throw error;
  }
  return result.exitCode === 0 ? parseAndroidEmulatorAvdNameOutput(result.stdout) : undefined;
}

function isAdbTimeout(error: unknown): boolean {
  return asAppError(error).details?.adbFailure === 'timeout';
}

/**
 * A busy device that times out a target probe stays listed with an unknown target, so it cannot
 * fail a request that selects another device. The selected serial and every other failure still
 * fail discovery, so a selected device never runs with a demoted target.
 */
function resolveTargetOrUnknown(
  context: AndroidInventoryContext,
  serial: string,
  resolve: () => 'mobile' | 'tv',
): 'mobile' | 'tv' | undefined {
  try {
    return resolve();
  } catch (error) {
    if (context.scope.signal.aborted || serial === context.selectedSerial || !isAdbTimeout(error)) {
      throw error;
    }
    context.scope.diagnostics.emit({
      level: 'warn',
      phase: 'android_inventory_target_probe_failed',
      data: { serial, adbFailure: 'timeout' },
    });
    return undefined;
  }
}

/**
 * `ro.build.characteristics`, then the feature list. `cmd package has-feature` is not asked: it
 * reads the same PackageManager feature table that `pm list features` prints.
 */
function resolveTarget(
  propsProbe: PromiseSettledResult<HostCommandResult>,
  props: AndroidDeviceProps | undefined,
  featuresProbe: PromiseSettledResult<HostCommandResult>,
): 'mobile' | 'tv' {
  if (propsProbe.status === 'rejected') throw propsProbe.reason;
  const characteristics = props?.['ro.build.characteristics'] ?? '';
  if (parseAndroidTargetFromCharacteristics(characteristics) === 'tv') return 'tv';
  if (featuresProbe.status === 'rejected') throw featuresProbe.reason;
  const features = commandOutput(featuresProbe.value);
  return TV_FEATURES.some((feature) => androidFeatureListDeclares(features, feature))
    ? 'tv'
    : 'mobile';
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

function adbShellArgv(serial: string, words: readonly ShellWord[]): readonly string[] {
  return deviceShellArgv('adb', 'shell', words, ['-s', serial]);
}

async function runAdbShell(
  context: AndroidInventoryContext,
  serial: string,
  words: readonly ShellWord[],
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<HostCommandResult> {
  return await run(context, context.adb, adbShellArgv(serial, words), timeoutMs);
}

async function run(
  context: AndroidInventoryContext,
  executable: string,
  args: readonly string[],
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<HostCommandResult> {
  try {
    return await context.host.commands.run(
      {
        executable,
        args,
        allowFailure: true,
        timeoutMs,
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
