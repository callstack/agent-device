import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import { bindAdmittedLocalInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import { keyboardRuntimeOperationFacts } from '@agent-device/contracts/keyboard-runtime';
import { orientationRuntimeOperationFacts } from '@agent-device/contracts/orientation-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { systemButtonRuntimeOperationFacts } from '@agent-device/contracts/system-button-runtime';
import { tvRemoteRuntimeOperationFacts } from '@agent-device/contracts/tv-remote-runtime';
import {
  hasAppleActionButton,
  isTvOsDevice,
  resolveDeviceAppleOs,
  type DeviceInfo,
} from '@agent-device/kernel/device';

const available = Object.freeze({ available: true } as const);

const backKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'back is supported on Apple simulators and physical devices.',
} as const);
const backOsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
/** No apple-family closure ever gated `back` beyond device kind: every other Apple OS, tvOS
 * included (the interactor drives the remote's Menu button there), supports it. */
function appleBackFact(device: DeviceInfo, watchHidAvailable: boolean): RuntimeOperationFact {
  if (device.kind !== 'simulator' && device.kind !== 'device') return backKindUnavailable;
  const os = resolveDeviceAppleOs(device);
  if (os === 'watchos') {
    return device.kind === 'simulator' && !device.simulatorSetPath && watchHidAvailable
      ? available
      : backOsUnavailable;
  }
  return available;
}

const homeKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'home is supported on Apple simulators and physical devices.',
} as const);
/** Parity with the retired `supportsAppAndDeviceLifecycle` closure: unavailable on macOS, which
 * drives an already-running app with no springboard home. watchOS Simulator maps home to the
 * Digital Crown hardware button through the isolated CoreSimulator backend. */
const homeLifecycleUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const appSwitcherKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'app-switcher is supported on Apple simulators and physical devices.',
} as const);
/**
 * `home` and `app-switcher` are one springboard reading, and sharing it here is parity rather
 * than convenience: the retired `supportsAppAndDeviceLifecycle` closure gated both off the same
 * per-AppleOS `appAndDeviceLifecycle` row. Only the kind-refusal hint differs, so each caller
 * supplies its own.
 */
function appleSpringboardFact(
  device: DeviceInfo,
  kindUnavailable: RuntimeOperationFact,
  watchHidAvailable: boolean,
): RuntimeOperationFact {
  if (device.kind !== 'simulator' && device.kind !== 'device') return kindUnavailable;
  const os = resolveDeviceAppleOs(device);
  if (os === 'watchos') {
    return device.kind === 'simulator' && !device.simulatorSetPath && watchHidAvailable
      ? available
      : homeLifecycleUnavailable;
  }
  return os === 'macos' ? homeLifecycleUnavailable : available;
}

function appleAppSwitcherFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.kind !== 'simulator' && device.kind !== 'device') {
    return appSwitcherKindUnavailable;
  }
  if (resolveDeviceAppleOs(device) === 'watchos') return homeLifecycleUnavailable;
  return appleSpringboardFact(device, appSwitcherKindUnavailable, false);
}

/**
 * The per-AppleOS mobile-input eligibility `orientation` and `keyboard` (dismiss/enter) share:
 * unavailable on tvOS (focus-only XCUIRemote navigation, no orientation or keyboard), macOS (an
 * AppKit desktop host, no device orientation or software keyboard), and watchOS (no constructible
 * interactor at all, see {@link backOsUnavailable}). Parity with the retired
 * `supportsOrientation`/`supportsKeyboard` closures, which read the same per-OS table.
 */
function appleMobileInputEligible(device: DeviceInfo): boolean {
  if (device.kind !== 'simulator' && device.kind !== 'device') return false;
  const os = resolveDeviceAppleOs(device);
  return os !== 'tvos' && os !== 'macos' && os !== 'watchos';
}

const orientationKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'orientation is supported on Apple simulators and physical devices.',
} as const);
const orientationOsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
function appleOrientationFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.kind !== 'simulator' && device.kind !== 'device') return orientationKindUnavailable;
  return appleMobileInputEligible(device) ? available : orientationOsUnavailable;
}

const tvRemoteUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'tv-remote is supported only on tvOS devices.',
} as const);
function appleTvRemoteFact(device: DeviceInfo): RuntimeOperationFact {
  return (device.kind === 'simulator' || device.kind === 'device') && isTvOsDevice(device)
    ? available
    : tvRemoteUnavailable;
}

/**
 * The outer keyboard cell, and this owner's keyboard-family refusal: unavailable with no hint,
 * matching the retired `supportsKeyboard` capability-bucket-level rejection (which carried no hint
 * text of its own).
 */
const keyboardCellUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const keyboardStatusUnsupported = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'keyboard status/get is currently supported only on Android; use keyboard dismiss or enter on iOS',
} as const);
/** Apple never had a live keyboard status read: every eligible cell still refuses `status`/`get`
 * with the retired in-handler hint. */
function appleKeyboardStatusFact(device: DeviceInfo): RuntimeOperationFact {
  return appleMobileInputEligible(device) ? keyboardStatusUnsupported : keyboardCellUnavailable;
}
function appleKeyboardDismissFact(device: DeviceInfo): RuntimeOperationFact {
  return appleMobileInputEligible(device) ? available : keyboardCellUnavailable;
}
function appleKeyboardEnterFact(device: DeviceInfo): RuntimeOperationFact {
  return appleMobileInputEligible(device) ? available : keyboardCellUnavailable;
}

/** Every system button this owner knows is named below; the family denial covers none today. */
const systemButtonUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'No Apple leaf carries this system button.',
} as const);
const actionButtonKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'action-button is supported on iPhone and iPad simulators and physical devices.',
} as const);
const actionButtonOsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'The Action Button is iPhone and iPad hardware; tvOS, macOS, watchOS and visionOS have no such control.',
} as const);
/**
 * The leaf reading is {@link hasAppleActionButton}, the same rule a provider owner reads; what this
 * owner adds is its kind gate. The leaf is the whole claim: which model inside it carries the button
 * is a hardware question the runner answers with `hasHardwareButton(.action)`, never a guess here.
 * iPhone and iPad is deliberately not {@link appleMobileInputEligible}, which is `orientation`'s
 * reading and admits visionOS — a headset has a Digital Crown and no Action Button.
 */
function appleActionButtonFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.kind !== 'simulator' && device.kind !== 'device') return actionButtonKindUnavailable;
  return hasAppleActionButton(device) ? available : actionButtonOsUnavailable;
}

/**
 * The navigation cells: back, home, app-switcher, action-button, orientation, tv-remote, and
 * keyboard status/dismiss/enter.
 */
export function appleNavigationFacts(device: DeviceInfo, watchHidAvailable = false) {
  return Object.freeze({
    ...backRuntimeOperationFacts({ back: appleBackFact(device, watchHidAvailable) }),
    ...systemButtonRuntimeOperationFacts({
      unsupported: systemButtonUnavailable,
      home: appleSpringboardFact(device, homeKindUnavailable, watchHidAvailable),
      appSwitcher: appleAppSwitcherFact(device),
      actionButton: appleActionButtonFact(device),
    }),
    ...orientationRuntimeOperationFacts({ orientation: appleOrientationFact(device) }),
    ...tvRemoteRuntimeOperationFacts({ tvRemote: appleTvRemoteFact(device) }),
    ...keyboardRuntimeOperationFacts({
      unsupported: keyboardCellUnavailable,
      status: appleKeyboardStatusFact(device),
      dismiss: appleKeyboardDismissFact(device),
      enter: appleKeyboardEnterFact(device),
    }),
  });
}

/** Binds whichever navigation operations {@link appleNavigationFacts} admitted. */
export function createAppleNavigationOperations(params: {
  host: Pick<PlatformRuntimeHost, 'localInteractors'>;
  device: DeviceInfo;
  signal: AbortSignal;
  watchHidAvailable?: boolean;
}) {
  const { host, device, signal, watchHidAvailable = false } = params;
  return bindAdmittedLocalInteractorOperations({
    device,
    signal,
    resolveInteractor: host.localInteractors.resolve,
    facts: appleNavigationFacts(device, watchHidAvailable),
  });
}
