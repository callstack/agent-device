import { setTimeout as sleep } from 'node:timers/promises';
import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import {
  bindProviderFocusInteractor,
  focusRuntimeOperationFacts,
} from '@agent-device/contracts/focus-runtime';
import { gestureRuntimeOperationFacts } from '@agent-device/contracts/gesture-runtime';
import {
  bindProviderScrollInteractor,
  scrollRuntimeOperationFacts,
} from '@agent-device/contracts/scroll-runtime';
import { appEventRuntimeOperationFacts } from '@agent-device/contracts/app-event-runtime';
import { settingsRuntimeOperationFacts } from '@agent-device/contracts/settings-runtime';
import { alertRuntimeOperationFacts } from '@agent-device/contracts/alert-runtime';
import { systemButtonRuntimeOperationFacts } from '@agent-device/contracts/system-button-runtime';
import { clipboardRuntimeOperationFacts } from '@agent-device/contracts/clipboard-runtime';
import { keyboardRuntimeOperationFacts } from '@agent-device/contracts/keyboard-runtime';
import { orientationRuntimeOperationFacts } from '@agent-device/contracts/orientation-runtime';
import { tvRemoteRuntimeOperationFacts } from '@agent-device/contracts/tv-remote-runtime';
import {
  bindProviderTypeTextInteractor,
  typeTextRuntimeOperationFacts,
} from '@agent-device/contracts/type-text-runtime';
import {
  bindProviderTouchInteractor,
  touchRuntimeOperationFacts,
} from '@agent-device/contracts/touch-runtime';
import { bindProviderScreenshotInteractor } from '@agent-device/contracts/screenshot-runtime';
import {
  bindProviderSnapshotInteractor,
  type SnapshotRuntimePresenter,
} from '@agent-device/contracts/snapshot-runtime';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import {
  type RuntimeOperationUnavailability,
  unavailableFact,
} from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';

export const available = Object.freeze({ available: true } as const);

/**
 * Revyl's text entry takes the field's coordinates, and no action injects text into whatever the
 * platform currently focuses. `fill` names a field, so it rides `/input`; `type` has nothing to
 * ride and is refused rather than sent to a point the caller never named.
 */
const typeTextUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl enters text at a point; run fill <field> "text" instead of type.',
);
/** The worker executes actions, not gesture plans; a plan has no action to send it to. */
const gestureUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl does not expose portable gesture execution.',
);
/**
 * Revyl's `/key` action accepts ENTER and BACKSPACE: one key rather than a keyboard surface. It
 * reports no visibility to echo and dismisses nothing, and a result that claimed either would name
 * the wrong platform, so the family is refused. Text entry rides `fill`.
 */
const keyboardUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl does not expose keyboard status, dismissal, or a return-key press.',
);
/** Neither platform carries a pasteboard action. */
const clipboardUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl does not expose the pasteboard.',
);
/** Revyl keeps the device in the orientation its session started in. */
const orientationUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl does not expose orientation control.',
);
/** Revyl's worker answers `/back` only on Android: iOS has no system back button to press. */
const iosBackUnavailable = unavailableFact(
  'unsupported-provider-mode',
  "Revyl has a back button only on Android; on iOS, click the app's own back control.",
);
/** `/go_home` is the only system button the worker answers. */
const systemButtonUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl exposes the home button only.',
);
const settingsUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl does not expose settings control.',
);
const appEventUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl does not deliver a push notification to a session.',
);
const alertUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Revyl has no alert surface of its own; a system alert appears in the snapshot tree.',
);
/**
 * Revyl rents phones and tablets. `tv-remote` presses keys only a TV target receives, and the
 * devices carry no receiver, so the cell refuses the target kind rather than the provider mode.
 */
const tvRemoteUnavailable = unavailableFact(
  'unsupported-device-kind',
  'tv-remote is supported only on Android TV targets; Revyl rents phones and tablets.',
);
/**
 * The refusal every cell reports when the device's session is gone. The owner's `inspectFacts` also
 * reports it for a device this runtime owns but has no live session for.
 */
export const liveSessionUnavailable = unavailableFact(
  'owner-capability-missing',
  'Revyl requires a matching live provider session for this device.',
);
export const REVYL_FOLD_UNAVAILABLE = unavailableFact(
  'unsupported-provider-mode',
  'fold runs a HID helper inside a foldable iPhone simulator on the daemon host; a Revyl session has no such simulator.',
);
export const REVYL_TELEPHONY_UNAVAILABLE = unavailableFact(
  'unsupported-provider-mode',
  "telephony sends calls and SMS to an Android emulator's console through local adb; agent-device does not route it through a Revyl session.",
);

/**
 * The interactor-backed interaction cells a live Revyl session serves. Everything available here
 * rides the session's device-proxy actions and a live session always has them, so the cells are
 * available together.
 */
export function revylInteractionOperationFacts(liveSession?: RuntimeOperationUnavailability) {
  const cell = liveSession ?? available;
  return Object.freeze({
    ...focusRuntimeOperationFacts({ focus: cell }),
    ...typeTextRuntimeOperationFacts({
      type: liveSession ?? typeTextUnavailable,
    }),
    ...touchRuntimeOperationFacts({
      unsupported:
        liveSession ??
        unavailableFact(
          'unsupported-provider-mode',
          'Revyl taps and fills at a point; it has no action for a hover or for a selector target.',
        ),
      tap: cell,
      longPress: cell,
      fill: cell,
    }),
    ...gestureRuntimeOperationFacts({
      unsupported: liveSession ?? gestureUnavailable,
    }),
    // A scroll is one drag of the planned finger path, so it needs no gesture execution.
    ...scrollRuntimeOperationFacts({ scroll: cell }),
  });
}

/**
 * The navigation cells, which differ from focus and touch because they are device buttons rather
 * than point actions: `back` and `home` are actions of their own, so they do not follow the point
 * cells' availability.
 */
export function revylNavigationOperationFacts(
  device: Pick<DeviceInfo, 'platform'>,
  liveSession?: RuntimeOperationUnavailability,
) {
  if (liveSession) {
    return Object.freeze({
      ...backRuntimeOperationFacts({ back: liveSession }),
      ...orientationRuntimeOperationFacts({
        orientation: liveSession,
        unlock: liveSession,
      }),
      ...systemButtonRuntimeOperationFacts({ unsupported: liveSession }),
      ...tvRemoteRuntimeOperationFacts({ tvRemote: liveSession }),
    });
  }
  return Object.freeze({
    ...backRuntimeOperationFacts({
      back: device.platform === 'android' ? available : iosBackUnavailable,
    }),
    ...orientationRuntimeOperationFacts({
      orientation: orientationUnavailable,
      unlock: orientationUnavailable,
    }),
    ...systemButtonRuntimeOperationFacts({
      unsupported: systemButtonUnavailable,
      home: available,
    }),
    ...tvRemoteRuntimeOperationFacts({ tvRemote: tvRemoteUnavailable }),
  });
}

/** The cells with no per-device split, refused on every Revyl session. */
export function revylUnsupportedOperationFacts(liveSession?: RuntimeOperationUnavailability) {
  return Object.freeze({
    ...keyboardRuntimeOperationFacts({
      unsupported: liveSession ?? keyboardUnavailable,
    }),
    ...clipboardRuntimeOperationFacts({
      unsupported: liveSession ?? clipboardUnavailable,
    }),
    // The gate is the device, so a live session refuses each setting for the provider-mode reason
    // and a gone one for the session reason; no setting either platform answers.
    ...settingsRuntimeOperationFacts({
      target: liveSession ?? available,
      unsupported: liveSession ?? settingsUnavailable,
      write: {},
    }),
    ...appEventRuntimeOperationFacts({
      triggerAppEvent: liveSession ?? appEventUnavailable,
    }),
    ...alertRuntimeOperationFacts({
      read: liveSession ?? alertUnavailable,
      wait: liveSession ?? alertUnavailable,
      accept: liveSession ?? alertUnavailable,
      dismiss: liveSession ?? alertUnavailable,
    }),
    setFoldPose: liveSession ?? REVYL_FOLD_UNAVAILABLE,
    sendTelephonyEvent: liveSession ?? REVYL_TELEPHONY_UNAVAILABLE,
  });
}

/**
 * Binds the operations that reach the device through the session's interactor: the two captures,
 * focus, touch and scroll. Refused cells stay absent from the binding, so a refusal is the facts'
 * answer and never a call that reaches a throwing interactor.
 */
export function bindRevylInteractionOperations(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
    presentIosAcquisition: SnapshotRuntimePresenter;
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
    ...bindProviderScreenshotInteractor({ device, signal, resolveInteractor }),
    ...bindProviderFocusInteractor({ device, signal, resolveInteractor }),
    ...bindProviderTypeTextInteractor({ device, signal, resolveInteractor }),
    ...bindProviderTouchInteractor({
      device,
      signal,
      resolveInteractor,
      facts: revylInteractionOperationFacts(),
      pause: async (milliseconds: number) => await sleep(milliseconds, undefined, { signal }),
    }),
    ...bindProviderScrollInteractor({ device, signal, resolveInteractor }),
  });
}
