import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import {
  bindProviderFocusInteractor,
  focusRuntimeOperationFacts,
} from '@agent-device/contracts/focus-runtime';
import { homeRuntimeOperationFacts } from '@agent-device/contracts/home-runtime';
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
import type { Interactor, RunnerContext } from '@agent-device/contracts/interaction';
import type { RuntimeOperationUnavailability } from '@agent-device/contracts/platform-runtime';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { setTimeout as sleep } from 'node:timers/promises';

const available = Object.freeze({ available: true } as const);
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
  });
}

/** Binds the interactor-backed operations (snapshot, screenshot, focus, type) for one session. */
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
