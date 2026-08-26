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
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { setTimeout as sleep } from 'node:timers/promises';

const available = Object.freeze({ available: true } as const);
/**
 * Limrun's iOS direct session drives text and touch but exposes no portable gesture execution —
 * its interactor's own `performGesture` refuses with this wording. Stating it as a fact refuses at
 * admission instead of mid-execution (ADR 0019 §6), keeping the agent-facing hint identical.
 */
const iosGestureUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun iOS direct sessions do not expose portable gesture execution yet.',
} as const);
const androidTvMultiTouchUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: ANDROID_TV_MULTI_TOUCH_UNSUPPORTED_HINT,
} as const);
const androidTvDragUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
} as const);

/**
 * Gesture cells split by the interactor behind the session: an Android emulator session runs the
 * ordinary Android interactor (every tier, minus the TV gates it always carried), while the iOS
 * direct session has no gesture execution at all.
 */
function limrunGestureFacts(
  device: DeviceInfo,
  cell: RuntimeOperationUnavailability | typeof available,
): GestureRuntimeOperationFacts {
  if (cell !== available) {
    return gestureRuntimeOperationFacts({
      plan: cell,
      directionalFling: cell,
      multiTouch: cell,
      targetAuthoredDrag: cell,
      viewport: cell,
    });
  }
  if (device.platform !== 'android') {
    return gestureRuntimeOperationFacts({
      plan: iosGestureUnavailable,
      directionalFling: iosGestureUnavailable,
      multiTouch: iosGestureUnavailable,
      targetAuthoredDrag: iosGestureUnavailable,
      viewport: iosGestureUnavailable,
    });
  }
  const tv = device.target === 'tv';
  return gestureRuntimeOperationFacts({
    plan: available,
    directionalFling: available,
    multiTouch: tv ? androidTvMultiTouchUnavailable : available,
    targetAuthoredDrag: tv ? androidTvDragUnavailable : available,
    viewport: available,
  });
}
const homeUnavailableIos = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun iOS direct sessions do not expose home yet.',
} as const);
const tvRemoteUnavailableIos = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun iOS direct sessions do not expose tv remote control.',
} as const);
const tvRemoteUnavailableAndroid = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'tv-remote is supported only on Android TV targets.',
} as const);
/**
 * The retired leaf never routed `keyboard` through provider resolution at all — it dispatched
 * directly by device platform, bypassing the interactor/provider seam entirely. The Android leg
 * genuinely carries it (the same `createAndroidInteractor` factory the local family binds); the
 * iOS leg has no such reuse, so it stays honestly unavailable rather than guessing at untested
 * provider behavior.
 */
const keyboardUnavailableIos = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun iOS direct sessions do not expose keyboard actions.',
} as const);
const clipboardUnavailableIos = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun iOS direct sessions do not expose clipboard access yet.',
} as const);
const settingsUnavailableIos = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun iOS direct sessions do not expose settings changes yet.',
} as const);
const appSwitcherUnavailableIos = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun iOS direct sessions do not expose app switcher yet.',
} as const);

/**
 * The interactor-backed interaction cells a live Limrun session serves: everything here rides
 * one provider interactor, and a live session always has one, so the cells are available
 * together. Extracted from the app-log owner because text/point interaction is not app-log
 * behavior — the owner module composes this, it does not define it.
 */
export function limrunInteractionOperationFacts(
  device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  const cell = liveSessionUnavailable ?? available;
  const unsupportedTouch = Object.freeze({
    available: false,
    reason: 'unsupported-provider-mode',
  } as const);
  return Object.freeze({
    ...focusRuntimeOperationFacts({ focus: cell }),
    ...typeTextRuntimeOperationFacts({ type: cell }),
    ...touchRuntimeOperationFacts({
      tap: cell,
      tapRef: unsupportedTouch,
      longPress: liveSessionUnavailable ?? (isIosFamily(device) ? unsupportedTouch : cell),
      hover: liveSessionUnavailable ?? {
        available: false,
        reason: 'unsupported-provider-mode',
        hint: 'hover raises pointer hover state and is available on web targets only. On touch platforms use longpress for hold gestures.',
      },
      hoverRef: unsupportedTouch,
      fill: cell,
      fillRef: unsupportedTouch,
      tapElementSelector: liveSessionUnavailable ?? (isIosFamily(device) ? cell : unsupportedTouch),
    }),
    ...limrunGestureFacts(device, cell),
    // `scroll` needs no gesture synthesis: both session kinds expose it directly.
    ...scrollRuntimeOperationFacts({ scroll: cell }),
  });
}

/**
 * Binds the interactor-backed operations (snapshot, screenshot, focus, type, gestures, scroll) for
 * one session. Only a live session reaches here, so the gesture tiers are gated by the same device
 * split their facts use rather than by liveness.
 */
export function bindLimrunInteractionOperations(
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
      facts: limrunInteractionOperationFacts(device),
      pause: async (milliseconds) => await sleep(milliseconds, undefined, { signal }),
    }),
    ...bindProviderScreenshotInteractor({ device, signal, resolveInteractor }),
    ...bindProviderGestureInteractor({
      device,
      signal,
      facts: limrunGestureFacts(device, available),
      resolveInteractor,
    }),
    ...bindProviderScrollInteractor({ device, signal, resolveInteractor }),
  });
}

/**
 * `back`/`home`/`orientation`/`tvRemote` differ by direct-session platform, unlike focus/type:
 * the Android leg rides `session.dependencies.android.createInteractor` (`android.ts`) — the
 * SAME factory the local Android family binds, so it carries the identical cell table (parity
 * with the local owner, including the `device.target === 'tv'` gate for `tvRemote`). The iOS leg
 * (`ios.ts`) implements `back`/`setOrientation` but explicitly refuses `home`/`tvRemote`.
 */
export function limrunNavigationOperationFacts(
  device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  if (liveSessionUnavailable) {
    return Object.freeze({
      ...backRuntimeOperationFacts({ back: liveSessionUnavailable }),
      ...homeRuntimeOperationFacts({ home: liveSessionUnavailable }),
      ...orientationRuntimeOperationFacts({ orientation: liveSessionUnavailable }),
      ...tvRemoteRuntimeOperationFacts({ tvRemote: liveSessionUnavailable }),
    });
  }
  if (device.platform === 'android') {
    return Object.freeze({
      ...backRuntimeOperationFacts({ back: available }),
      ...homeRuntimeOperationFacts({ home: available }),
      ...orientationRuntimeOperationFacts({ orientation: available }),
      ...tvRemoteRuntimeOperationFacts({
        tvRemote: device.target === 'tv' ? available : tvRemoteUnavailableAndroid,
      }),
    });
  }
  return Object.freeze({
    ...backRuntimeOperationFacts({ back: available }),
    ...homeRuntimeOperationFacts({ home: homeUnavailableIos }),
    ...orientationRuntimeOperationFacts({ orientation: available }),
    ...tvRemoteRuntimeOperationFacts({ tvRemote: tvRemoteUnavailableIos }),
  });
}

/**
 * `keyboard` (status/dismiss/enter) shares one cell per session: the Android leg rides the same
 * interactor factory `limrunNavigationOperationFacts` above describes; the iOS leg has no tested
 * provider keyboard behavior, so it stays unavailable.
 */
/**
 * `clipboard` shares the split its siblings have: the Android leg rides
 * `session.dependencies.android.createInteractor` — the SAME factory the local Android family
 * binds, so `cmd clipboard get/set text` reaches the device exactly as it does locally — while
 * the iOS leg's own `readClipboard`/`writeClipboard` throw, so both cells stay unavailable there
 * and carry the interactor's wording.
 */
export function limrunClipboardOperationFacts(
  device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  const cell =
    liveSessionUnavailable ?? (device.platform === 'android' ? available : clipboardUnavailableIos);
  return Object.freeze({ ...clipboardRuntimeOperationFacts({ read: cell, write: cell }) });
}

const alertUnavailableIos = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun iOS direct sessions do not expose alert inspection yet.',
} as const);

/**
 * `alert` splits like every other interaction leaf: the Android leg rides the local family's own
 * interactor factory, which reads the same accessibility dump it always did; the iOS direct
 * session has no XCUITest runner to read a sheet from, so all four legs refuse together.
 */
export function limrunAlertOperationFacts(
  device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  const cell =
    liveSessionUnavailable ?? (device.platform === 'android' ? available : alertUnavailableIos);
  return Object.freeze({
    ...alertRuntimeOperationFacts({ read: cell, wait: cell, accept: cell, dismiss: cell }),
  });
}

/**
 * `app-switcher` splits the same way its siblings do: the Android leg rides
 * `session.dependencies.android.createInteractor` -- the SAME factory the local Android family
 * binds -- while the iOS leg's own `appSwitcher` throws.
 */
export function limrunAppSwitcherOperationFacts(
  device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  const cell =
    liveSessionUnavailable ??
    (device.platform === 'android' ? available : appSwitcherUnavailableIos);
  return Object.freeze({ ...appSwitcherRuntimeOperationFacts({ appSwitcher: cell }) });
}

/**
 * `trigger-app-event` is the one system leaf both direct-session legs genuinely serve: each
 * implements `open`, and a deep link is exactly what that method routes (`openUrl` on iOS, the
 * local Android interactor's `am start` on Android).
 */
export function limrunAppEventOperationFacts(
  device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  void device;
  return Object.freeze({
    ...appEventRuntimeOperationFacts({ triggerAppEvent: liveSessionUnavailable ?? available }),
  });
}

/**
 * `settings` splits the same way `app-switcher` does: the Android leg rides the local family's
 * own interactor factory, while the iOS leg's `setSetting` throws.
 */
export function limrunSettingsOperationFacts(
  device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  const cell =
    liveSessionUnavailable ?? (device.platform === 'android' ? available : settingsUnavailableIos);
  return Object.freeze({ ...settingsRuntimeOperationFacts({ setSetting: cell }) });
}

export function limrunKeyboardOperationFacts(
  device: DeviceInfo,
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  const cell =
    liveSessionUnavailable ?? (device.platform === 'android' ? available : keyboardUnavailableIos);
  return Object.freeze({
    ...keyboardRuntimeOperationFacts({ status: cell, dismiss: cell, enter: cell }),
  });
}
