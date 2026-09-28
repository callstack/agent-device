import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type {
  PairWearableInput,
  WearablePairingRuntimeResult,
} from '@agent-device/contracts/wearable-pairing-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
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
  let devices = await discover(host, signal);
  let wearable = await selectWearable(host, devices, phone, input, signal);
  let launchedPid: number | undefined;
  try {
    if (wearable.kind !== 'emulator') {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Pairing is supported only with Android Wear emulators; physical Wear pairing is not automated.',
        { hint: 'Use an Android Wear emulator and complete the phone-side companion setup as the reported human step.' },
      );
    }
    if (input.boot && wearable.booted !== true) {
      if (wearable.kind !== 'emulator') {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Only a Wear emulator can be booted automatically.',
        );
      }
      launchedPid = host.deviceReadiness.androidEmulator.launch(wearable.name, false);
      for (let attempt = 0; attempt < DISCOVERY_ATTEMPTS; attempt += 1) {
        signal.throwIfAborted();
        await host.clock.sleep(1_000, signal);
        devices = await discover(host, signal);
        const refreshed = devices.find(
          (candidate) => candidate.id === wearable.id || candidate.name === wearable.name,
        );
        if (refreshed?.booted) {
          wearable = refreshed;
          break;
        }
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
          ['shell', 'getprop', 'ro.build.characteristics'],
          { allowFailure: true, timeoutMs: 10_000 },
          signal,
        ),
        host.androidTools.runAdb(
          wearable,
          ['shell', 'pm', 'list', 'features'],
          { allowFailure: true, timeoutMs: 10_000 },
          signal,
        ),
      ]);
      const hasWatchCharacteristic = characteristics.stdout
        .split(/[\s,]+/)
        .some((value) => value.toLowerCase() === 'watch');
      const hasWatchFeature = /^feature:android\.hardware\.type\.watch\s*$/im.test(
        features.stdout,
      );
      if (
        characteristics.exitCode !== 0 &&
        features.exitCode !== 0
      ) {
        throw new AppError(
          'COMMAND_FAILED',
          'Unable to verify the selected Android target is a Wear device.',
        );
      }
      if (!hasWatchCharacteristic && !hasWatchFeature) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'The selected Android target does not identify itself as a Wear device.',
          { hint: 'Select a Wear OS target with the watch build characteristic or hardware feature.' },
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

async function discover(host: PlatformRuntimeHost, signal: AbortSignal) {
  return await host.deviceReadiness.androidEmulator.discover(
    { platform: 'android', androidAvdSelection: 'include-stopped' },
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
  const requested = input.wearable;
  const candidates = devices.filter(
    (device) =>
      device.id !== phone.id &&
      device.target !== 'tv' &&
      (!requested?.deviceId || device.id === requested.deviceId) &&
      (!requested?.name || device.name === requested.name),
  );
  const namedWearables = candidates.filter((device) => /\b(?:wear|watch)\b/i.test(device.name));
  if (requested && candidates.length === 1) return { ...candidates[0]! };
  if (!requested && namedWearables.length === 1) return { ...namedWearables[0]! };
  if (candidates.length === 0 || (!requested && namedWearables.length === 0)) {
    if (!requested) {
      const runningCandidates = candidates.filter((device) => device.booted === true);
      const featureMatches: DeviceInfo[] = [];
      for (const device of runningCandidates) {
        const result = await host.androidTools.runAdb(
          device,
          ['shell', 'pm', 'list', 'features'],
          { allowFailure: true, timeoutMs: 10_000 },
          signal,
        );
        if (result.exitCode !== 0) {
          throw new AppError(
            'COMMAND_FAILED',
            `Unable to inspect Android target ${device.id} for Wear OS features.`,
          );
        }
        if (/^feature:android\.hardware\.type\.watch\s*$/im.test(result.stdout)) {
          featureMatches.push(device);
        }
      }
      if (featureMatches.length === 1) return { ...featureMatches[0]! };
      if (featureMatches.length > 1) {
        throw new AppError('INVALID_ARGS', 'More than one Wear OS target matches; provide deviceId or name.', {
          candidates: featureMatches.map(({ id, name }) => ({ id, name })),
        });
      }
      const stoppedEmulators = candidates.filter(
        (device) => device.kind === 'emulator' && device.booted === false,
      );
      if (input.boot && stoppedEmulators.length === 1) return { ...stoppedEmulators[0]! };
    }
    throw new AppError('DEVICE_NOT_FOUND', 'No matching Wear OS device or emulator is available.');
  }
  const matches = requested ? candidates : namedWearables;
  throw new AppError('INVALID_ARGS', 'More than one Wear OS target matches; provide deviceId or name.', {
    candidates: matches.map(({ id, name }) => ({ id, name })),
  });
}
