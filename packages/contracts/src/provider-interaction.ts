import { bindProviderElementTextRuntime } from './element-text-runtime.ts';
import type { PlatformRuntimeOperations } from './platform-runtime-operations.ts';
import {
  type RuntimeFacts,
  unavailableFact,
  whenAdmitted,
  PLATFORM_RUNTIME_REASONS,
} from './platform-runtime.ts';
import { backRuntimeOperationFacts } from './back-runtime.ts';
import { bindProviderFocusInteractor, focusRuntimeOperationFacts } from './focus-runtime.ts';
import {
  ANDROID_TV_MULTI_TOUCH_UNSUPPORTED_HINT,
  TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
} from './gesture-admission.ts';
import { bindProviderGestureInteractor, gestureRuntimeOperationFacts } from './gesture-runtime.ts';
import { bindProviderScrollInteractor, scrollRuntimeOperationFacts } from './scroll-runtime.ts';
import { appEventRuntimeOperationFacts } from './app-event-runtime.ts';
import { alertRuntimeOperationFacts } from './alert-runtime.ts';
import {
  androidHardwareButtonFacts,
  systemButtonRuntimeOperationFacts,
} from './system-button-runtime.ts';
import { clipboardRuntimeOperationFacts } from './clipboard-runtime.ts';
import { keyboardRuntimeOperationFacts } from './keyboard-runtime.ts';
import { orientationRuntimeOperationFacts } from './orientation-runtime.ts';
import { bindProviderScreenshotInteractor, defaultCaptureOnly } from './screenshot-runtime.ts';
import {
  bindProviderSnapshotInteractor,
  type SnapshotRuntimePresenter,
} from './snapshot-runtime.ts';
import { tvRemoteRuntimeOperationFacts } from './tv-remote-runtime.ts';
import {
  bindProviderTypeTextInteractor,
  typeTextRuntimeOperationFacts,
} from './type-text-runtime.ts';
import { bindProviderTouchInteractor, touchRuntimeOperationFacts } from './touch-runtime.ts';
import type { Interactor, RunnerContext } from './interactor-types.ts';
import { type DeviceInfo } from '@agent-device/kernel/device';
import { setTimeout as sleep } from 'node:timers/promises';

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

export function bindProviderInteractionOperations(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor;
    presentIosAcquisition?: SnapshotRuntimePresenter;
    screenshotHint: string;
    facts: RuntimeFacts<PlatformRuntimeOperations>['operations'];
  }>,
) {
  const { device, signal } = params;
  const resolveInteractor = (runner: RunnerContext) => params.getInteractor(device, runner);
  return Object.freeze({
    ...whenAdmitted(params.facts.readTextAtPoint, () =>
      bindProviderElementTextRuntime({ device, signal, resolveInteractor }),
    ),
    ...bindProviderSnapshotInteractor({
      device,
      signal,
      resolveInteractor,
      presentIosAcquisition: params.presentIosAcquisition,
    }),
    ...bindProviderFocusInteractor({ device, signal, resolveInteractor }),
    ...bindProviderTypeTextInteractor({ device, signal, resolveInteractor }),
    ...bindProviderTouchInteractor({
      device,
      signal,
      resolveInteractor,
      facts: params.facts,
      pause: async (milliseconds) => await sleep(milliseconds, undefined, { signal }),
    }),
    ...bindProviderScreenshotInteractor({
      device,
      signal,
      resolveInteractor,
      captureCapabilities: defaultCaptureOnly(params.screenshotHint),
    }),
    ...bindProviderGestureInteractor({
      device,
      signal,
      facts: params.facts,
      resolveInteractor,
    }),
    ...bindProviderScrollInteractor({ device, signal, resolveInteractor }),
  });
}
