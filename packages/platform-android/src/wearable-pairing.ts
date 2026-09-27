import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type {
  PairWearableInput,
  WearablePairingRuntimeResult,
} from '@agent-device/contracts/wearable-pairing-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

const DISCOVERY_ATTEMPTS = 60;

export async function pairAndroidWearable(
  host: PlatformRuntimeHost,
  phone: DeviceInfo,
  input: PairWearableInput,
  signal: AbortSignal,
): Promise<WearablePairingRuntimeResult> {
  let devices = await discover(host, signal);
  let wearable = selectWearable(devices, phone, input);
  let launchedPid: number | undefined;
  try {
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

function selectWearable(
  devices: readonly DeviceInfo[],
  phone: DeviceInfo,
  input: PairWearableInput,
): DeviceInfo {
  const requested = input.wearable;
  const matches = devices.filter(
    (device) =>
      device.id !== phone.id &&
      (!requested?.deviceId || device.id === requested.deviceId) &&
      (!requested?.name || device.name === requested.name) &&
      (requested?.deviceId !== undefined ||
        requested?.name !== undefined ||
        /\bwear\b/i.test(device.name)),
  );
  if (matches.length === 1) return { ...matches[0]! };
  if (matches.length === 0) {
    throw new AppError('DEVICE_NOT_FOUND', 'No matching Wear OS device or emulator is available.');
  }
  throw new AppError(
    'INVALID_ARGS',
    'More than one Wear OS target matches; provide deviceId or name.',
    {
      candidates: matches.map(({ id, name }) => ({ id, name })),
    },
  );
}
