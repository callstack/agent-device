import { Deadline, pollUntilSettled } from '@agent-device/host-kit/retry';
import {
  AppError,
  createRequestCanceledError,
  discloseDispatch,
} from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runAndroidShell } from './adb.ts';
import { androidAdbResultError } from './adb-failure.ts';
import { readAndroidSdkInt } from './device-sdk-int.ts';
import { androidFeatureListDeclares } from './inventory-parsers.ts';

const NO_BLUETOOTH_ADAPTER_REASON = 'android_bluetooth_adapter_missing';
const BLUETOOTH_COMMAND_UNAVAILABLE_REASON = 'android_bluetooth_command_unavailable';
const BLUETOOTH_NOT_APPLIED_REASON = 'bluetooth-not-applied';
const BLUETOOTH_UNREADABLE_REASON = 'bluetooth-unreadable';

/** Without this feature no Bluetooth service starts, and `svc bluetooth` exits 0 having done nothing. */
const BLUETOOTH_FEATURE = 'android.hardware.bluetooth';

/**
 * Android 8.1. Older `svc` prints its help for an unknown command and exits 0. From Android 13
 * `svc bluetooth` forwards to `cmd bluetooth_manager`, so one command serves every level.
 */
const SVC_BLUETOOTH_MIN_SDK = 27;

/** `svc bluetooth` exits 0 when the adapter refuses the change, so the write is confirmed by reading it back. */
const BLUETOOTH_STATE_DEADLINE_MS = 2_000;
const BLUETOOTH_STATE_POLL_INTERVAL_MS = 200;

type AndroidBluetoothState = 'enabled' | 'disabled';

/** The adapter and the API level are proven before the write. */
export async function setAndroidBluetooth(
  device: DeviceInfo,
  enabled: boolean,
  signal: AbortSignal | undefined,
): Promise<{ bluetooth: AndroidBluetoothState }> {
  try {
    await requireAndroidSvcBluetooth(device, signal);
    if (signal?.aborted) throw createRequestCanceledError();
  } catch (error) {
    throw error instanceof AppError ? discloseDispatch(error, 'no') : error;
  }
  const requested: AndroidBluetoothState = enabled ? 'enabled' : 'disabled';
  try {
    const result = await runAndroidShell(
      device,
      ['svc', 'bluetooth', enabled ? 'enable' : 'disable'],
      { allowFailure: true, signal },
    );
    if (result.exitCode !== 0) {
      throw androidAdbResultError(
        `Failed to turn Android Bluetooth ${enabled ? 'on' : 'off'}`,
        result,
        { deviceId: device.id },
      );
    }
    return { bluetooth: await awaitAndroidBluetoothState(device, requested, signal) };
  } catch (error) {
    throw error instanceof AppError ? discloseDispatch(error, 'unknown') : error;
  }
}

async function requireAndroidSvcBluetooth(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<void> {
  const features = await runAndroidShell(device, ['pm', 'list', 'features'], {
    allowFailure: true,
    signal,
  });
  if (features.exitCode !== 0) {
    throw androidAdbResultError('Failed to read Android device features', features, {
      deviceId: device.id,
    });
  }
  if (!androidFeatureListDeclares(features.stdout, BLUETOOTH_FEATURE)) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'This Android device has no Bluetooth adapter, so nothing was changed.',
      {
        reason: NO_BLUETOOTH_ADAPTER_REASON,
        deviceId: device.id,
        hint: `Some emulator images ship without Bluetooth. Use a device or emulator image whose pm list features includes ${BLUETOOTH_FEATURE}.`,
      },
    );
  }
  const { sdkInt, result: sdkResult } = await readAndroidSdkInt(device, signal);
  if (sdkInt === null) {
    throw androidAdbResultError(
      'Failed to read the Android API level, so nothing was changed.',
      sdkResult,
      { deviceId: device.id },
    );
  }
  if (sdkInt < SVC_BLUETOOTH_MIN_SDK) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'This Android build has no shell command for Bluetooth, so nothing was changed.',
      {
        reason: BLUETOOTH_COMMAND_UNAVAILABLE_REASON,
        deviceId: device.id,
        sdkInt,
        hint: 'settings bluetooth needs svc bluetooth, which requires Android 8.1 (API 27) or newer. Use a newer device or emulator image.',
      },
    );
  }
}

async function awaitAndroidBluetoothState(
  device: DeviceInfo,
  requested: AndroidBluetoothState,
  signal: AbortSignal | undefined,
): Promise<AndroidBluetoothState> {
  const deadline = Deadline.fromTimeoutMs(BLUETOOTH_STATE_DEADLINE_MS);
  const { settled, value } = await pollUntilSettled({
    probe: async () => {
      const result = await runAndroidShell(device, ['settings', 'get', 'global', 'bluetooth_on'], {
        allowFailure: true,
        signal,
        timeoutMs: Math.max(1, deadline.remainingMs()),
      });
      if (result.exitCode !== 0) {
        throw androidAdbResultError('Failed to read Android Bluetooth state', result, {
          deviceId: device.id,
        });
      }
      const storedValue = result.stdout.trim();
      return { storedValue, bluetooth: parseAndroidBluetoothState(storedValue) };
    },
    settled: (read) => read.bluetooth === requested,
    deadline,
    intervalMs: BLUETOOTH_STATE_POLL_INTERVAL_MS,
    signal,
  });
  if (settled) return requested;
  throw androidBluetoothSettleError(device, requested, value.bluetooth, value.storedValue);
}

/**
 * The state the Bluetooth manager persists: `bluetooth_on` is 1 while the adapter is on, and 0, or 2
 * when airplane mode turned it off.
 */
function parseAndroidBluetoothState(storedValue: string): AndroidBluetoothState | undefined {
  if (storedValue === '1') return 'enabled';
  if (storedValue === '0' || storedValue === '2') return 'disabled';
  return undefined;
}

function androidBluetoothSettleError(
  device: DeviceInfo,
  requested: AndroidBluetoothState,
  bluetooth: AndroidBluetoothState | undefined,
  storedValue: string,
): AppError {
  const message =
    bluetooth === undefined
      ? `Android reported an unusable bluetooth_on value after requesting Bluetooth ${requested}: ${storedValue || '(empty)'}`
      : `Android Bluetooth reads ${bluetooth} after requesting ${requested}.`;
  return new AppError('COMMAND_FAILED', message, {
    deviceId: device.id,
    reason: bluetooth === undefined ? BLUETOOTH_UNREADABLE_REASON : BLUETOOTH_NOT_APPLIED_REASON,
    requested,
    ...(bluetooth === undefined ? {} : { bluetooth }),
    storedValue,
    hint: 'A device policy or user restriction can block Bluetooth changes. Run `adb shell settings get global bluetooth_on` to see what the device holds.',
  });
}
