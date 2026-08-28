import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import {
  bindProviderFocusInteractor,
  focusRuntimeOperationFacts,
} from '@agent-device/contracts/focus-runtime';
import {
  bindProviderGestureInteractor,
  gestureRuntimeOperationFacts,
  type GestureRuntimeOperationFacts,
} from '@agent-device/contracts/gesture-runtime';
import {
  bindProviderScrollInteractor,
  scrollRuntimeOperationFacts,
} from '@agent-device/contracts/scroll-runtime';
import { homeRuntimeOperationFacts } from '@agent-device/contracts/home-runtime';
import { appEventRuntimeOperationFacts } from '@agent-device/contracts/app-event-runtime';
import { settingsRuntimeOperationFacts } from '@agent-device/contracts/settings-runtime';
import { alertRuntimeOperationFacts } from '@agent-device/contracts/alert-runtime';
import { appSwitcherRuntimeOperationFacts } from '@agent-device/contracts/app-switcher-runtime';
import { clipboardRuntimeOperationFacts } from '@agent-device/contracts/clipboard-runtime';
import { keyboardRuntimeOperationFacts } from '@agent-device/contracts/keyboard-runtime';
import { orientationRuntimeOperationFacts } from '@agent-device/contracts/orientation-runtime';
import { bindProviderScreenshotInteractor } from '@agent-device/contracts/screenshot-runtime';
import { bindProviderSnapshotInteractor } from '@agent-device/contracts/snapshot-runtime';
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
import type { RuntimeOperationUnavailability } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DOUBLESPEED_IOS_ALERT_UNSUPPORTED,
  DOUBLESPEED_IOS_BACK_UNSUPPORTED,
  DOUBLESPEED_IOS_GESTURE_UNSUPPORTED,
} from './ios.ts';

const available = Object.freeze({ available: true } as const);
const unsupportedTouch = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
} as const);
const hoverUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'hover raises pointer hover state and is available on web targets only. On touch platforms use longpress for hold gestures.',
} as const);
/**
 * The session drives text and touch but exposes no portable gesture execution — its interactor's
 * own `performGesture` refuses with this wording. Stating it as a fact refuses at admission
 * instead of mid-execution (ADR 0019 §6), keeping the agent-facing hint identical.
 */
const gestureUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: DOUBLESPEED_IOS_GESTURE_UNSUPPORTED,
} as const);
const backUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: DOUBLESPEED_IOS_BACK_UNSUPPORTED,
} as const);
const tvRemoteUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Doublespeed iOS sessions do not expose tv remote control.',
} as const);
const keyboardUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Doublespeed iOS sessions do not expose keyboard actions.',
} as const);
const clipboardUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Doublespeed iOS sessions do not expose clipboard access yet.',
} as const);
const settingsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Doublespeed iOS sessions do not expose settings changes yet.',
} as const);
const appSwitcherUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Doublespeed iOS sessions do not expose app switcher yet.',
} as const);
const alertUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: DOUBLESPEED_IOS_ALERT_UNSUPPORTED,
} as const);

function doublespeedGestureFacts(
  cell: RuntimeOperationUnavailability | typeof available,
): GestureRuntimeOperationFacts {
  const gesture = cell === available ? gestureUnavailable : cell;
  return gestureRuntimeOperationFacts({
    plan: gesture,
    directionalFling: gesture,
    multiTouch: gesture,
    targetAuthoredDrag: gesture,
    viewport: gesture,
  });
}

/**
 * The interactor-backed interaction cells a live session serves: everything here rides one
 * provider interactor, and a live session always has one, so the cells are available together.
 */
export function doublespeedInteractionOperationFacts(
  _device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  const cell = liveSessionUnavailable ?? available;
  return Object.freeze({
    ...focusRuntimeOperationFacts({ focus: cell }),
    ...typeTextRuntimeOperationFacts({ type: cell }),
    ...touchRuntimeOperationFacts({
      tap: cell,
      tapRef: unsupportedTouch,
      longPress: cell,
      hover: liveSessionUnavailable ?? hoverUnavailable,
      hoverRef: unsupportedTouch,
      fill: cell,
      fillRef: unsupportedTouch,
      tapElementSelector: cell,
    }),
    ...doublespeedGestureFacts(cell),
    ...scrollRuntimeOperationFacts({ scroll: cell }),
  });
}

/** Binds the interactor-backed operations (snapshot, screenshot, focus, type, touch, scroll). */
export function bindDoublespeedInteractionOperations(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
  }>,
) {
  const { device, signal } = params;
  const resolveInteractor = (runner: RunnerContext) => params.getInteractor(device, runner);
  return Object.freeze({
    ...bindProviderSnapshotInteractor({ device, signal, resolveInteractor }),
    ...bindProviderFocusInteractor({ device, signal, resolveInteractor }),
    ...bindProviderTypeTextInteractor({ device, signal, resolveInteractor }),
    ...bindProviderTouchInteractor({
      device,
      signal,
      resolveInteractor,
      facts: doublespeedInteractionOperationFacts(device),
      pause: async (milliseconds) => await sleep(milliseconds, undefined, { signal }),
    }),
    ...bindProviderScreenshotInteractor({ device, signal, resolveInteractor }),
    ...bindProviderGestureInteractor({
      device,
      signal,
      facts: doublespeedGestureFacts(available),
      resolveInteractor,
    }),
    ...bindProviderScrollInteractor({ device, signal, resolveInteractor }),
  });
}

/** `home` and `orientation` ride the session; `back` and `tvRemote` have no iOS-simulator leg. */
export function doublespeedNavigationOperationFacts(
  _device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  return Object.freeze({
    ...backRuntimeOperationFacts({ back: liveSessionUnavailable ?? backUnavailable }),
    ...homeRuntimeOperationFacts({ home: liveSessionUnavailable ?? available }),
    ...orientationRuntimeOperationFacts({ orientation: liveSessionUnavailable ?? available }),
    ...tvRemoteRuntimeOperationFacts({ tvRemote: liveSessionUnavailable ?? tvRemoteUnavailable }),
  });
}

export function doublespeedKeyboardOperationFacts(
  _device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  const cell = liveSessionUnavailable ?? keyboardUnavailable;
  return Object.freeze({
    ...keyboardRuntimeOperationFacts({ status: cell, dismiss: cell, enter: cell }),
  });
}

export function doublespeedClipboardOperationFacts(
  _device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  const cell = liveSessionUnavailable ?? clipboardUnavailable;
  return Object.freeze({ ...clipboardRuntimeOperationFacts({ read: cell, write: cell }) });
}

export function doublespeedAlertOperationFacts(
  _device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  const cell = liveSessionUnavailable ?? alertUnavailable;
  return Object.freeze({
    ...alertRuntimeOperationFacts({ read: cell, wait: cell, accept: cell, dismiss: cell }),
  });
}

export function doublespeedAppSwitcherOperationFacts(
  _device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  return Object.freeze({
    ...appSwitcherRuntimeOperationFacts({
      appSwitcher: liveSessionUnavailable ?? appSwitcherUnavailable,
    }),
  });
}

/** A deep link is exactly what the interactor's `open` routes, so app-event delivery is served. */
export function doublespeedAppEventOperationFacts(
  _device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  return Object.freeze({
    ...appEventRuntimeOperationFacts({ triggerAppEvent: liveSessionUnavailable ?? available }),
  });
}

export function doublespeedSettingsOperationFacts(
  _device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  return Object.freeze({
    ...settingsRuntimeOperationFacts({ setSetting: liveSessionUnavailable ?? settingsUnavailable }),
  });
}
