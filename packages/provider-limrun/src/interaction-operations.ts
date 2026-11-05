import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import {
  type RuntimeFacts,
  type RuntimeOperationFact,
  type RuntimeOperationUnavailability,
  unavailableFact,
} from '@agent-device/contracts/platform-runtime';
import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import {
  bindProviderFocusInteractor,
  focusRuntimeOperationFacts,
} from '@agent-device/contracts/focus-runtime';
import {
  ANDROID_TV_MULTI_TOUCH_UNSUPPORTED_HINT,
  TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
} from '@agent-device/contracts/gesture-admission';
import {
  bindProviderGestureInteractor,
  gestureRuntimeOperationFacts,
} from '@agent-device/contracts/gesture-runtime';
import {
  bindProviderScrollInteractor,
  scrollRuntimeOperationFacts,
} from '@agent-device/contracts/scroll-runtime';
import { appEventRuntimeOperationFacts } from '@agent-device/contracts/app-event-runtime';
import { settingsRuntimeOperationFacts } from '@agent-device/contracts/settings-runtime';
import type { AndroidSetting } from '@agent-device/platform-android/mechanics';
import { alertRuntimeOperationFacts } from '@agent-device/contracts/alert-runtime';
import {
  androidHardwareButtonFacts,
  systemButtonRuntimeOperationFacts,
} from '@agent-device/contracts/system-button-runtime';
import { clipboardRuntimeOperationFacts } from '@agent-device/contracts/clipboard-runtime';
import { keyboardRuntimeOperationFacts } from '@agent-device/contracts/keyboard-runtime';
import { orientationRuntimeOperationFacts } from '@agent-device/contracts/orientation-runtime';
import { bindProviderScreenshotInteractor } from '@agent-device/contracts/screenshot-runtime';
import {
  bindProviderSnapshotInteractor,
  type SnapshotRuntimePresenter,
} from '@agent-device/contracts/snapshot-runtime';
import { tvRemoteRuntimeOperationFacts } from '@agent-device/contracts/tv-remote-runtime';
import {
  bindProviderTypeTextInteractor,
  typeTextRuntimeOperationFacts,
} from '@agent-device/contracts/type-text-runtime';
import {
  bindProviderTouchInteractor,
  touchRuntimeOperationFacts,
} from '@agent-device/contracts/touch-runtime';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import { type DeviceInfo } from '@agent-device/kernel/device';
import { setTimeout as sleep } from 'node:timers/promises';

const available = Object.freeze({ available: true } as const);
const unsupported = unavailableFact('unsupported-provider-mode');
const settingUnavailableAndroid = unavailableFact(
  'unsupported-platform-leaf',
  'Run `agent-device settings --help` for the settings each target serves.',
);
export const LIMRUN_FOLD_UNAVAILABLE = unavailableFact(
  'unsupported-provider-mode',
  'Limrun exposes the commanded hinge angle, but fold requires an independently observed angle to verify the pose.',
);
export const LIMRUN_TELEPHONY_UNAVAILABLE = unavailableFact(
  'unsupported-provider-mode',
  "telephony sends calls and SMS to an Android emulator's console through local adb; agent-device does not route it through a Limrun session.",
);

export function limrunAndroidInteractionFacts(device: DeviceInfo) {
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
        ? unavailableFact('unsupported-platform-leaf', ANDROID_TV_MULTI_TOUCH_UNSUPPORTED_HINT)
        : available,
      targetAuthoredDrag: tv
        ? unavailableFact('unsupported-platform-leaf', TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT)
        : available,
    }),
    ...scrollRuntimeOperationFacts({ scroll: available }),
    ...backRuntimeOperationFacts({ back: available }),
    ...orientationRuntimeOperationFacts({ orientation: available, unlock: available }),
    ...tvRemoteRuntimeOperationFacts({
      tvRemote: tv
        ? available
        : unavailableFact(
            'unsupported-device-kind',
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

export function bindLimrunInteractionOperations(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
    presentIosAcquisition: SnapshotRuntimePresenter;
    facts: RuntimeFacts<PlatformRuntimeOperations>['operations'];
  }>,
) {
  const { device, signal } = params;
  const resolveInteractor = (runner: RunnerContext) => params.getInteractor(device, runner);
  return Object.freeze({
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
    ...bindProviderScreenshotInteractor({ device, signal, resolveInteractor }),
    ...bindProviderGestureInteractor({
      device,
      signal,
      facts: params.facts,
      resolveInteractor,
    }),
    ...bindProviderScrollInteractor({ device, signal, resolveInteractor }),
  });
}

export function limrunAndroidSettingsFacts(
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  return settingsRuntimeOperationFacts({
    target: liveSessionUnavailable ?? available,
    unsupported: settingUnavailableAndroid,
    write: {
      wifi: available,
      bluetooth: available,
      airplane: available,
      'mobile-data': available,
      location: available,
      animations: available,
      appearance: available,
      'text-size': available,
      fingerprint: available,
      'clear-app-state': available,
      permission: available,
    } satisfies Record<AndroidSetting, RuntimeOperationFact>,
    read: { 'text-size': available },
  });
}

export function limrunAppleSettingsFacts(
  facts: Partial<RuntimeFacts<PlatformRuntimeOperations>['operations']>,
) {
  const setting = facts.setSetting;
  return {
    readSetting: facts.readSetting ?? unsupported,
    setSetting: setting?.available
      ? {
          ...setting,
          subjects: {
            ...setting.subjects,
            'reset-keychain': unavailableFact(
              'unsupported-provider-mode',
              'Limrun does not expose keychain reset.',
            ),
          },
        }
      : (setting ?? unsupported),
  };
}
