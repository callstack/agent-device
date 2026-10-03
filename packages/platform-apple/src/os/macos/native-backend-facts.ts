import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import { gestureRuntimeOperationFacts } from '@agent-device/contracts/gesture-runtime';
import type { RuntimeOperationUnavailability } from '@agent-device/contracts/platform-runtime';
import type { MacOsAppBackend } from '@agent-device/contracts/session';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';

const nativeBackendUnavailable: RuntimeOperationUnavailability = Object.freeze({
  available: false,
  reason: 'unsupported-device-backend',
  hint: 'The native macOS app backend never starts the XCTest runner, which this command needs. Unset AGENT_DEVICE_MACOS_APP_BACKEND to use XCTest.',
});

/**
 * The macOS operations only the XCTest runner can serve. Under the native backend they are
 * refused at admission, before dispatch, for every macOS session of the daemon: the backend is a
 * daemon setting, so no session on it may start the runner. Spread last over the leaf's facts.
 */
export function macOsNativeBackendFacts(device: DeviceInfo, appBackend: MacOsAppBackend) {
  if (!isMacOs(device) || appBackend !== 'native') return {};
  return Object.freeze({
    screenRecordingStart: nativeBackendUnavailable,
    screenRecordingReattach: nativeBackendUnavailable,
    prepareAppleRunner: nativeBackendUnavailable,
    longPressPoint: nativeBackendUnavailable,
    ...backRuntimeOperationFacts({ back: nativeBackendUnavailable }),
    ...gestureRuntimeOperationFacts({ unsupported: nativeBackendUnavailable }),
  });
}
