import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import { bindAdmittedLocalInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import { keyboardRuntimeOperationFacts } from '@agent-device/contracts/keyboard-runtime';
import { orientationRuntimeOperationFacts } from '@agent-device/contracts/orientation-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { systemButtonRuntimeOperationFacts } from '@agent-device/contracts/system-button-runtime';
import { tvRemoteRuntimeOperationFacts } from '@agent-device/contracts/tv-remote-runtime';
import { tvRemoteButtonsForPlatform } from '@agent-device/contracts/tv-remote';
import {
  isHandheldAppleDevice,
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
/** visionOS has no back gesture or button; the runner refuses the same way if reached directly. */
const backVisionOsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'visionOS has no back command. Press the visible back control by its ref.',
} as const);
/** tvOS presses the remote's Menu button, macOS taps the window back control, and iOS and watchOS
 * press the navigation bar back button or swipe from the left edge. visionOS has no back. */
function appleBackFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.kind !== 'simulator' && device.kind !== 'device') return backKindUnavailable;
  const os = resolveDeviceAppleOs(device);
  return os === 'visionos' ? backVisionOsUnavailable : available;
}

const homeKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'home is supported on Apple simulators and physical devices.',
} as const);
/** Parity with the retired `supportsAppAndDeviceLifecycle` closure: unavailable on macOS, which
 * drives an already-running app with no springboard home. */
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
): RuntimeOperationFact {
  if (device.kind !== 'simulator' && device.kind !== 'device') return kindUnavailable;
  const os = resolveDeviceAppleOs(device);
  return os === 'macos' ? homeLifecycleUnavailable : available;
}

/**
 * The per-AppleOS mobile-input eligibility `orientation` and `keyboard` (dismiss/enter) share:
 * unavailable on tvOS (focus-only XCUIRemote navigation, no orientation or keyboard), macOS (an
 * AppKit desktop host, no device orientation or software keyboard). Parity with the retired
 * `supportsOrientation`/`supportsKeyboard` closures, which read the same per-OS table.
 */
function appleMobileInputEligible(device: DeviceInfo): boolean {
  if (device.kind !== 'simulator' && device.kind !== 'device') return false;
  const os = resolveDeviceAppleOs(device);
  return os !== 'tvos' && os !== 'macos';
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
/**
 * `dismiss` and `enter` press the software keyboard, which every handheld Apple leaf has, so both
 * read `orientation`'s eligibility: unavailable on tvOS, macOS and watchOS, available on iOS and
 * visionOS, where the keyboard exists even though the runner reads it differently.
 */
function appleKeyboardFact(device: DeviceInfo): RuntimeOperationFact {
  return appleMobileInputEligible(device) ? available : keyboardCellUnavailable;
}
/**
 * `status` is the one leg the runner can only serve on iOS and iPadOS: it answers from the key
 * elements `observedKeyboardKeys(in:)` reads, and that read is `#if os(iOS)` code which queries
 * `app.keyboards` and answers nothing elsewhere. On visionOS the same guard makes the visibility read
 * answer `nil`, so a caller would get "keyboard hidden" for a keyboard that may be up. visionOS hears
 * the same refusal as the leaves with no keyboard at all.
 */
function appleKeyboardStatusFact(device: DeviceInfo): RuntimeOperationFact {
  if (!appleMobileInputEligible(device)) return keyboardCellUnavailable;
  return isHandheldAppleDevice(device) ? available : keyboardCellUnavailable;
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
  hint: 'action-button is supported on iPhone and iPad simulators and physical devices, and on Apple Watch simulators.',
} as const);
const actionButtonOsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'The Action Button is iPhone, iPad, and Apple Watch Ultra hardware; tvOS, macOS and visionOS have no such control.',
} as const);
/**
 * The leaf reading is {@link isHandheldAppleDevice}, the same rule a provider owner reads; what
 * this owner adds is its kind gate. `DeviceInfo` records no model identifier, so which iPhone or
 * iPad carries the button is a hardware question the runner answers with
 * `hasHardwareButton(.action)`, on a watch as on a phone (Apple Watch Ultra has the button). iPhone
 * and iPad is deliberately not {@link appleMobileInputEligible}, which is `orientation`'s reading and
 * admits visionOS.
 */
function appleActionButtonFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.kind !== 'simulator' && device.kind !== 'device') return actionButtonKindUnavailable;
  return isHandheldAppleDevice(device) || device.appleOs === 'watchos'
    ? available
    : actionButtonOsUnavailable;
}

const volumeButtonOsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'hardware-button volume presses the iPhone/iPad volume key; this Apple leaf has none.',
} as const);
const volumeButtonSimulatorUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'hardware-button volume is supported on physical iPhone and iPad; iOS Simulators refuse because XCUIDevice exposes no volume press there.',
} as const);
/**
 * `XCUIDevice.press(.volumeUp/.volumeDown)` is simulator-unavailable in the XCUITest header, so
 * the local runner presses volume on a physical iPhone or iPad only. The iPhone/iPad leaf read is
 * {@link isHandheldAppleDevice}; tvOS, macOS, watchOS and visionOS have no volume key to press and
 * hear that refusal, not the simulator one.
 */
function appleVolumeButtonFact(device: DeviceInfo): RuntimeOperationFact {
  if (!isHandheldAppleDevice(device)) return volumeButtonOsUnavailable;
  if (device.kind !== 'device') return volumeButtonSimulatorUnavailable;
  return available;
}

/**
 * The navigation cells: back, home, app-switcher, action-button, orientation, tv-remote, and
 * keyboard status/dismiss/enter.
 */
export function appleNavigationFacts(device: DeviceInfo) {
  return Object.freeze({
    ...backRuntimeOperationFacts({ back: appleBackFact(device) }),
    ...systemButtonRuntimeOperationFacts({
      unsupported: systemButtonUnavailable,
      home: appleSpringboardFact(device, homeKindUnavailable),
      appSwitcher: appleSpringboardFact(device, appSwitcherKindUnavailable),
      actionButton: appleActionButtonFact(device),
      // Power is the family denial: Apple exposes no public power/lock button press to XCUITest,
      // on any kind or OS, so no cell overrides it.
      volumeUp: appleVolumeButtonFact(device),
      volumeDown: appleVolumeButtonFact(device),
    }),
    ...orientationRuntimeOperationFacts({ orientation: appleOrientationFact(device) }),
    ...tvRemoteRuntimeOperationFacts({
      tvRemote: appleTvRemoteFact(device),
      buttonSupport: {
        supported: tvRemoteButtonsForPlatform('apple'),
        unsupported: {
          available: false,
          reason: 'unsupported-platform-leaf',
          hint: 'This TV remote button is not supported on tvOS.',
        },
      },
    }),
    ...keyboardRuntimeOperationFacts({
      unsupported: keyboardCellUnavailable,
      status: appleKeyboardStatusFact(device),
      dismiss: appleKeyboardFact(device),
      enter: appleKeyboardFact(device),
    }),
  });
}

/**
 * Binds whichever navigation operations the device's admitted facts allow. The cells are those
 * {@link appleNavigationFacts} declares, read from the admitted facts so a refusal layered over
 * the leaf (a backend that cannot serve one) also withholds the binding.
 */
export function createAppleNavigationOperations(params: {
  host: Pick<PlatformRuntimeHost, 'localInteractors'>;
  device: DeviceInfo;
  signal: AbortSignal;
  admitted: Readonly<Record<string, RuntimeOperationFact>>;
}) {
  const { host, device, signal, admitted } = params;
  const navigationKeys = Object.keys(appleNavigationFacts(device)) as Array<
    keyof ReturnType<typeof appleNavigationFacts>
  >;
  return bindAdmittedLocalInteractorOperations({
    device,
    signal,
    resolveInteractor: host.localInteractors.resolve,
    facts: Object.fromEntries(navigationKeys.map((key) => [key, admitted[key]])) as ReturnType<
      typeof appleNavigationFacts
    >,
  });
}
