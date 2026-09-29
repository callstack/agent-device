import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type {
  PairWearableInput,
  WearablePairingRuntimeResult,
} from '@agent-device/contracts/wearable-pairing-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { AppError } from '@agent-device/kernel/errors';

const DISCOVERY_ATTEMPTS = 60;

// Pairing is one transactional lifecycle: discovery, optional boot, transport proof, and rollback.
// fallow-ignore-next-line complexity
export async function pairAndroidWearable(
  host: PlatformRuntimeHost,
  phone: DeviceInfo,
  input: PairWearableInput,
  signal: AbortSignal,
): Promise<WearablePairingRuntimeResult> {
  let devices = await discover(host, signal, input.androidSerialAllowlist);
  let wearable = await selectWearable(host, devices, phone, input, signal);
  let launchedPid: number | undefined;
  try {
    if (wearable.kind !== 'emulator') {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Pairing is supported only with Android Wear emulators; physical Wear pairing is not automated.',
        {
          hint: 'Use an Android Wear emulator and complete the phone-side companion setup as the reported human step.',
        },
      );
    }
    if (input.boot && wearable.booted !== true) {
      launchedPid = host.deviceReadiness.androidEmulator.launch(wearable.name, false);
      for (let attempt = 0; attempt < DISCOVERY_ATTEMPTS; attempt += 1) {
        signal.throwIfAborted();
        await host.clock.sleep(1_000, signal);
        devices = await discover(host, signal, input.androidSerialAllowlist);
        const refreshed =
          devices.find(
            (candidate) => candidate.kind === 'emulator' && candidate.id === wearable.id,
          ) ??
          (() => {
            const sameNameEmulators = devices.filter(
              (candidate) => candidate.kind === 'emulator' && candidate.name === wearable.name,
            );
            return sameNameEmulators.length === 1 ? sameNameEmulators[0] : undefined;
          })();
        if (refreshed?.booted) {
          wearable = refreshed;
          break;
        }
      }
      if (wearable.kind !== 'emulator') {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Only a Wear emulator can be booted automatically.',
        );
      }
      if (!wearable.booted) {
        throw new AppError('COMMAND_FAILED', 'Wear emulator did not finish booting.');
      }
    }

    if (wearable.booted) {
      const state = await host.androidTools.runAdb(
        wearable,
        ['get-state'],
        { allowFailure: true, timeoutMs: 10_000 },
        signal,
      );
      if (state.exitCode !== 0 || state.stdout.trim() !== 'device') {
        throw new AppError('COMMAND_FAILED', 'ADB transport to the Wear device is not ready.');
      }
      const [characteristics, features] = await Promise.all([
        host.androidTools.runAdb(
          wearable,
          deviceShellArgv('adb', 'shell', ['getprop', 'ro.build.characteristics']),
          { allowFailure: true, timeoutMs: 10_000 },
          signal,
        ),
        host.androidTools.runAdb(
          wearable,
          deviceShellArgv('adb', 'shell', ['pm', 'list', 'features']),
          { allowFailure: true, timeoutMs: 10_000 },
          signal,
        ),
      ]);
      const hasWatchCharacteristic = characteristics.stdout
        .split(/[\s,]+/)
        .some((value) => value.toLowerCase() === 'watch');
      const hasWatchFeature = /^feature:android\.hardware\.type\.watch\s*$/im.test(features.stdout);
      if (characteristics.exitCode !== 0 && features.exitCode !== 0) {
        throw new AppError(
          'COMMAND_FAILED',
          'Unable to verify the selected Android target is a Wear device.',
        );
      }
      if (!hasWatchCharacteristic && !hasWatchFeature) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'The selected Android target does not identify itself as a Wear device.',
          {
            hint: 'Select a Wear OS target with the watch build characteristic or hardware feature.',
          },
        );
      }
    } else {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'A stopped Wear target cannot be verified without booting it.',
        { hint: 'Pass --boot to start the Wear emulator and verify its device characteristics.' },
      );
    }

    return {
      pairId: `android:${phone.id}:${wearable.id}`,
      phone,
      wearable,
      status: 'human-step-required',
      remainingHumanStep:
        'Complete companion pairing in the Android phone and Wear OS setup UI; ADB transport alone does not prove a connected wearable pair.',
    };
  } catch (error) {
    if (launchedPid !== undefined) {
      await host.deviceReadiness.androidEmulator.terminate(launchedPid).catch(() => undefined);
    }
    throw error;
  }
}

async function discover(
  host: PlatformRuntimeHost,
  signal: AbortSignal,
  androidSerialAllowlist?: readonly string[],
) {
  return await host.deviceReadiness.androidEmulator.discover(
    {
      platform: 'android',
      androidAvdSelection: 'include-stopped',
      ...(androidSerialAllowlist ? { androidSerialAllowlist: [...androidSerialAllowlist] } : {}),
    },
    signal,
  );
}

async function selectWearable(
  host: PlatformRuntimeHost,
  devices: readonly DeviceInfo[],
  phone: DeviceInfo,
  input: PairWearableInput,
  signal: AbortSignal,
): Promise<DeviceInfo> {
  const candidates = findWearableCandidates(devices, phone, input.wearable);
  const directMatch = selectRequestedOrNamedWearable(candidates, input.wearable);
  if (directMatch) return directMatch;
  if (input.wearable) throwNoWearable();
  return await selectWearableByRuntimeEvidence(host, candidates, input.boot, signal);
}

function findWearableCandidates(
  devices: readonly DeviceInfo[],
  phone: DeviceInfo,
  requested: PairWearableInput['wearable'],
): DeviceInfo[] {
  return devices.filter(
    (device) =>
      device.id !== phone.id &&
      device.target !== 'tv' &&
      (!requested?.deviceId || device.id === requested.deviceId) &&
      (!requested?.name || device.name === requested.name),
  );
}

function selectRequestedOrNamedWearable(
  candidates: readonly DeviceInfo[],
  requested: PairWearableInput['wearable'],
): DeviceInfo | undefined {
  if (requested) {
    if (candidates.length === 1) return { ...candidates[0]! };
    if (candidates.length > 1) throwAmbiguousWearables(candidates);
    return undefined;
  }

  const named = candidates.filter((device) => /\b(?:wear|watch)\b/i.test(device.name));
  if (named.length === 1) return { ...named[0]! };
  if (named.length > 1) throwAmbiguousWearables(named);
  return undefined;
}

async function selectWearableByRuntimeEvidence(
  host: PlatformRuntimeHost,
  candidates: readonly DeviceInfo[],
  shouldBoot: boolean,
  signal: AbortSignal,
): Promise<DeviceInfo> {
  const runningCandidates = candidates.filter((device) => device.booted === true);
  const probe = await probeWearableFeatures(host, runningCandidates, signal);
  if (probe.matches.length === 1) return { ...probe.matches[0]! };
  if (probe.matches.length > 1) throwAmbiguousWearables(probe.matches);
  if (runningCandidates.length > 0 && probe.succeeded === 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Unable to inspect any running Android target for Wear OS features.',
      { deviceIds: probe.failures },
    );
  }

  const stoppedEmulators = candidates.filter(
    (device) => device.kind === 'emulator' && device.booted === false,
  );
  if (shouldBoot && stoppedEmulators.length === 1) return { ...stoppedEmulators[0]! };
  throwNoWearable();
}

async function probeWearableFeatures(
  host: PlatformRuntimeHost,
  devices: readonly DeviceInfo[],
  signal: AbortSignal,
): Promise<{ matches: DeviceInfo[]; failures: string[]; succeeded: number }> {
  const matches: DeviceInfo[] = [];
  const failures: string[] = [];
  let succeeded = 0;
  for (const device of devices) {
    const features = await readWearFeatures(host, device, signal);
    if (features === undefined) {
      failures.push(device.id);
      continue;
    }
    succeeded += 1;
    if (/^feature:android\.hardware\.type\.watch\s*$/im.test(features)) matches.push(device);
  }
  return { matches, failures, succeeded };
}

async function readWearFeatures(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await host.androidTools.runAdb(
      device,
      deviceShellArgv('adb', 'shell', ['pm', 'list', 'features']),
      { allowFailure: true, timeoutMs: 10_000 },
      signal,
    );
    return result.exitCode === 0 ? result.stdout : undefined;
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

function throwAmbiguousWearables(devices: readonly DeviceInfo[]): never {
  throw new AppError(
    'INVALID_ARGS',
    'More than one Wear OS target matches; provide deviceId or name.',
    { candidates: devices.map(({ id, name }) => ({ id, name })) },
  );
}

function throwNoWearable(): never {
  throw new AppError('DEVICE_NOT_FOUND', 'No matching Wear OS device or emulator is available.');
}
