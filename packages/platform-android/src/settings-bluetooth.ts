import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runAndroidShell } from './adb.ts';
import { androidAdbResultError } from './adb-failure.ts';
import { readAndroidSdkInt } from './device-sdk-int.ts';
import { androidFeatureListDeclares } from './inventory-parsers.ts';
import {
  setAndroidGlobalToggle,
  type AndroidGlobalToggle,
  type AndroidToggleState,
} from './settings-global-toggle.ts';

const NO_BLUETOOTH_ADAPTER_REASON = 'android_bluetooth_adapter_missing';
const BLUETOOTH_COMMAND_UNAVAILABLE_REASON = 'android_bluetooth_command_unavailable';

/** Without this feature no Bluetooth service starts, and `svc bluetooth` exits 0 having done nothing. */
const BLUETOOTH_FEATURE = 'android.hardware.bluetooth';

/**
 * Android 8.1. Older `svc` prints its help for an unknown command and exits 0. From Android 13
 * `svc bluetooth` forwards to `cmd bluetooth_manager`, so one command serves every level.
 */
const SVC_BLUETOOTH_MIN_SDK = 27;

/**
 * The Bluetooth manager persists `bluetooth_on`: 1 while the adapter is on, and 0, or 2 when
 * airplane mode turned it off. `svc bluetooth` exits 0 when the adapter refuses the change.
 */
const BLUETOOTH_TOGGLE: AndroidGlobalToggle<'bluetooth'> = {
  service: 'bluetooth',
  row: 'bluetooth_on',
  label: 'Bluetooth',
  stateKey: 'bluetooth',
  parseRow: (storedValue) => {
    if (storedValue === '1') return 'enabled';
    if (storedValue === '0' || storedValue === '2') return 'disabled';
    return undefined;
  },
  notAppliedReason: 'bluetooth-not-applied',
  unreadableReason: 'bluetooth-unreadable',
  sampleIntervalMs: 200,
  hint: 'A device policy or user restriction can block Bluetooth changes. Run `adb shell settings get global bluetooth_on` to see what the device holds.',
};

/** The adapter and the API level are proven before the write. */
export async function setAndroidBluetooth(
  device: DeviceInfo,
  enabled: boolean,
  signal: AbortSignal | undefined,
): Promise<{ bluetooth: AndroidToggleState }> {
  try {
    await requireAndroidSvcBluetooth(device, signal);
  } catch (error) {
    throw error instanceof AppError ? discloseDispatch(error, 'no') : error;
  }
  return await setAndroidGlobalToggle(device, BLUETOOTH_TOGGLE, enabled, signal);
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
