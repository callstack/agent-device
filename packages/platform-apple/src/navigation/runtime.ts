import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import { homeRuntimeOperationFacts } from '@agent-device/contracts/home-runtime';
import { bindAdmittedLocalInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import { keyboardRuntimeOperationFacts } from '@agent-device/contracts/keyboard-runtime';
import { orientationRuntimeOperationFacts } from '@agent-device/contracts/orientation-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { tvRemoteRuntimeOperationFacts } from '@agent-device/contracts/tv-remote-runtime';
import { isTvOsDevice, resolveDeviceAppleOs, type DeviceInfo } from '@agent-device/kernel/device';

const available = Object.freeze({ available: true } as const);

const backKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'back is supported on Apple simulators and physical devices.',
} as const);
/** watchOS has no XCUITest-driveable UI (ADR-0009): no Apple interactor can be constructed for
 * it, so every interactor-backed operation below stays unavailable there regardless of what the
 * retired per-command capability table said for it — facts are the support authority (ADR 0019),
 * not a mirror of a table that never modeled interactor constructibility. */
const backOsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
/** No apple-family closure ever gated `back` beyond device kind: every other Apple OS, tvOS
 * included (the interactor drives the remote's Menu button there), supports it. */
function appleBackFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.kind !== 'simulator' && device.kind !== 'device') return backKindUnavailable;
  return resolveDeviceAppleOs(device) === 'watchos' ? backOsUnavailable : available;
}

const homeKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'home is supported on Apple simulators and physical devices.',
} as const);
/** Parity with the retired `supportsAppAndDeviceLifecycle` closure: unavailable on macOS, which
 * drives an already-running app with no springboard home; also unavailable on watchOS, whose
 * interactor cannot be constructed at all (see {@link backOsUnavailable}). */
const homeLifecycleUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
function appleHomeFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.kind !== 'simulator' && device.kind !== 'device') return homeKindUnavailable;
  const os = resolveDeviceAppleOs(device);
  return os === 'macos' || os === 'watchos' ? homeLifecycleUnavailable : available;
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

/** The outer keyboard cell: unavailable with no hint, matching the retired `supportsKeyboard`
 * capability-bucket-level rejection (which carried no hint text of its own). */
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

/** The navigation cells: back, home, orientation, tv-remote, and keyboard status/dismiss/enter. */
export function appleNavigationFacts(device: DeviceInfo) {
  return Object.freeze({
    ...backRuntimeOperationFacts({ back: appleBackFact(device) }),
    ...homeRuntimeOperationFacts({ home: appleHomeFact(device) }),
    ...orientationRuntimeOperationFacts({ orientation: appleOrientationFact(device) }),
    ...tvRemoteRuntimeOperationFacts({ tvRemote: appleTvRemoteFact(device) }),
    ...keyboardRuntimeOperationFacts({
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
}) {
  const { host, device, signal } = params;
  return bindAdmittedLocalInteractorOperations({
    device,
    signal,
    resolveInteractor: host.localInteractors.resolve,
    facts: appleNavigationFacts(device),
  });
}
