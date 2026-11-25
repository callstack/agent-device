import {
  unavailableFact,
  PLATFORM_RUNTIME_REASONS,
} from '@agent-device/contracts/platform-runtime';
import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import { focusRuntimeOperationFacts } from '@agent-device/contracts/focus-runtime';
import {
  ANDROID_TV_MULTI_TOUCH_UNSUPPORTED_HINT,
  TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
} from '@agent-device/contracts/gesture-admission';
import { gestureRuntimeOperationFacts } from '@agent-device/contracts/gesture-runtime';
import { scrollRuntimeOperationFacts } from '@agent-device/contracts/scroll-runtime';
import { appEventRuntimeOperationFacts } from '@agent-device/contracts/app-event-runtime';
import { alertRuntimeOperationFacts } from '@agent-device/contracts/alert-runtime';
import {
  androidHardwareButtonFacts,
  systemButtonRuntimeOperationFacts,
} from '@agent-device/contracts/system-button-runtime';
import { clipboardRuntimeOperationFacts } from '@agent-device/contracts/clipboard-runtime';
import { keyboardRuntimeOperationFacts } from '@agent-device/contracts/keyboard-runtime';
import { orientationRuntimeOperationFacts } from '@agent-device/contracts/orientation-runtime';
import { tvRemoteRuntimeOperationFacts } from '@agent-device/contracts/tv-remote-runtime';
import { typeTextRuntimeOperationFacts } from '@agent-device/contracts/type-text-runtime';
import { touchRuntimeOperationFacts } from '@agent-device/contracts/touch-runtime';
import { type DeviceInfo } from '@agent-device/kernel/device';

const available = Object.freeze({ available: true } as const);
const unsupported = unavailableFact(PLATFORM_RUNTIME_REASONS.unsupportedProviderMode.reason);
export function providerAndroidInteractionFacts(device: DeviceInfo) {
  const tv = device.target === 'tv';
  return {
    ...focusRuntimeOperationFacts({ focus: available }),
    ...typeTextRuntimeOperationFacts({ type: available }),
    ...touchRuntimeOperationFacts({
      unsupported,
      tap: available,
      longPress: available,
      fill: available,
    }),
    ...gestureRuntimeOperationFacts({
      unsupported,
      plan: available,
      directionalFling: available,
      viewport: available,
      multiTouch: tv
        ? unavailableFact(
            PLATFORM_RUNTIME_REASONS.unsupportedPlatformLeaf.reason,
            ANDROID_TV_MULTI_TOUCH_UNSUPPORTED_HINT,
          )
        : available,
      targetAuthoredDrag: tv
        ? unavailableFact(
            PLATFORM_RUNTIME_REASONS.unsupportedPlatformLeaf.reason,
            TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
          )
        : available,
    }),
    ...scrollRuntimeOperationFacts({ scroll: available }),
    ...backRuntimeOperationFacts({ back: available }),
    ...orientationRuntimeOperationFacts({ orientation: available, unlock: available }),
    ...tvRemoteRuntimeOperationFacts({
      tvRemote: tv
        ? available
        : unavailableFact(
            PLATFORM_RUNTIME_REASONS.unsupportedDeviceKind.reason,
            'tv-remote is supported only on Android TV targets.',
          ),
    }),
    ...keyboardRuntimeOperationFacts({
      unsupported,
      status: available,
      dismiss: available,
      enter: available,
    }),
    ...clipboardRuntimeOperationFacts({ unsupported, read: available, write: available }),
    ...systemButtonRuntimeOperationFacts({
      unsupported,
      home: available,
      appSwitcher: available,
      ...androidHardwareButtonFacts(device),
    }),
    ...alertRuntimeOperationFacts({
      read: available,
      wait: available,
      accept: available,
      dismiss: available,
    }),
    ...appEventRuntimeOperationFacts({ triggerAppEvent: available }),
  };
}
