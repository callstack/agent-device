import type { EnsureReadyInput } from '@agent-device/contracts/device-readiness-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';

/** Readiness reads exactly these host ports; the lifecycle binding composes the same subset. */
export type AndroidReadinessHost = Pick<
  PlatformRuntimeHost,
  'clock' | 'commands' | 'deviceReadiness' | 'toolchains'
>;
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

const BOOT_TIMEOUT_MS = 120_000;
const POLL_MS = 1_000;

export async function ensureAndroidReady(
  host: AndroidReadinessHost,
  device: DeviceInfo,
  input: EnsureReadyInput & Readonly<{ headless: boolean }>,
  signal: AbortSignal,
): Promise<DeviceInfo> {
  signal.throwIfAborted();
  if (device.kind === 'emulator' && (device.booted !== true || !isRunningEmulator(device))) {
    return await ensureEmulatorReady(host, device, input, signal);
  }
  if (device.booted !== true) await waitForBoot(host, device.id, BOOT_TIMEOUT_MS, signal);
  return { ...device, booted: true };
}

async function ensureEmulatorReady(
  host: AndroidReadinessHost,
  device: DeviceInfo,
  input: EnsureReadyInput & Readonly<{ headless: boolean }>,
  signal: AbortSignal,
): Promise<DeviceInfo> {
  await prepareAndroidEmulatorToolchain(host);
  const request = inventoryRequest(input);
  const available = await host.deviceReadiness.androidEmulator.discover(request, signal);
  const selected = requireAvailableAvd(available, device.name, input.serial);

  const existing = isRunningEmulator(selected) ? selected : undefined;
  const launchedPid = existing
    ? undefined
    : host.deviceReadiness.androidEmulator.launch(selected.name, input.headless);
  try {
    const discovered =
      existing ?? (await waitForDiscovery(host, selected.name, request, input.serial, signal));
    await waitForBoot(host, discovered.id, BOOT_TIMEOUT_MS, signal);
    const refreshed = (await host.deviceReadiness.androidEmulator.discover(request, signal)).find(
      (candidate) => candidate.id === discovered.id,
    );
    return { ...(refreshed ?? discovered), name: selected.name, booted: true };
  } catch (error) {
    if (launchedPid !== undefined && signal.aborted) {
      await host.deviceReadiness.androidEmulator.terminate(launchedPid);
    }
    signal.throwIfAborted();
    throw error;
  }
}

async function prepareAndroidEmulatorToolchain(host: AndroidReadinessHost): Promise<void> {
  await host.toolchains.prepare('android');
  if (!(await host.commands.which('adb'))) {
    throw new AppError('TOOL_MISSING', 'adb not found in PATH');
  }
  if (!(await host.commands.which('emulator'))) {
    throw new AppError('TOOL_MISSING', 'emulator not found in PATH');
  }
}

function requireAvailableAvd(
  available: readonly DeviceInfo[],
  avdName: string,
  serial?: string,
): DeviceInfo {
  const selected = findByAvdName(available, avdName, serial);
  if (selected) return selected;
  throw new AppError('DEVICE_NOT_FOUND', `No Android emulator AVD named ${avdName}`, {
    requestedAvdName: avdName,
    availableAvds: available.map((candidate) => candidate.name),
    hint: 'Run `emulator -list-avds` and pass an existing AVD name to --device.',
  });
}

async function waitForDiscovery(
  host: AndroidReadinessHost,
  avdName: string,
  request: ReturnType<typeof inventoryRequest>,
  serial: string | undefined,
  signal: AbortSignal,
): Promise<DeviceInfo> {
  const deadline = host.clock.now() + BOOT_TIMEOUT_MS;
  while (host.clock.now() < deadline) {
    const devices = await host.deviceReadiness.androidEmulator.discover(request, signal);
    const device = findByAvdName(devices, avdName, serial);
    if (device && isRunningEmulator(device)) return device;
    await host.clock.sleep(POLL_MS, signal);
  }
  throw new AppError('COMMAND_FAILED', 'Android emulator did not appear in time', {
    avdName,
    serial,
    timeoutMs: BOOT_TIMEOUT_MS,
  });
}

async function waitForBoot(
  host: AndroidReadinessHost,
  serial: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = host.clock.now() + timeoutMs;
  while (host.clock.now() < deadline) {
    const result = await host.commands.run(
      {
        executable: 'adb',
        args: ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
        allowFailure: true,
        timeoutMs: Math.min(10_000, Math.max(1_000, deadline - host.clock.now())),
      },
      signal,
    );
    if (result.stdout.trim() === '1') return;
    await host.clock.sleep(POLL_MS, signal);
  }
  throw new AppError('COMMAND_FAILED', 'Android device failed to finish booting', {
    serial,
    timeoutMs,
    reason: 'ANDROID_BOOT_TIMEOUT',
  });
}

function inventoryRequest(input: EnsureReadyInput) {
  return {
    platform: 'android' as const,
    kind: 'emulator' as const,
    ...(input.serial ? { serial: input.serial } : {}),
    ...(input.androidSerialAllowlist
      ? { androidSerialAllowlist: [...input.androidSerialAllowlist] }
      : {}),
  };
}

function findByAvdName(
  devices: readonly DeviceInfo[],
  avdName: string,
  serial?: string,
): DeviceInfo | undefined {
  const expected = normalizeName(avdName);
  return devices.find(
    (candidate) =>
      candidate.platform === 'android' &&
      candidate.kind === 'emulator' &&
      normalizeName(candidate.name) === expected &&
      (!serial || !isRunningEmulator(candidate) || candidate.id === serial),
  );
}

function isRunningEmulator(device: DeviceInfo): boolean {
  return device.id.startsWith('emulator-');
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}
