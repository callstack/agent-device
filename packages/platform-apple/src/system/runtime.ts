import { alertRuntimeOperationFacts } from '@agent-device/contracts/alert-runtime';
import { appEventRuntimeOperationFacts } from '@agent-device/contracts/app-event-runtime';
import { clipboardRuntimeOperationFacts } from '@agent-device/contracts/clipboard-runtime';
import { settingsRuntimeOperationFacts } from '@agent-device/contracts/settings-runtime';
import { bindAdmittedLocalInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type {
  RuntimeOperationFact,
  RuntimeOperationUnavailability,
} from '@agent-device/contracts/platform-runtime';
import {
  isHandheldAppleSimulator,
  isMacOs,
  resolveDeviceAppleOs,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import type { AppleSimulatorSetting, MacOsHostSetting } from '../core/app-settings.ts';

const available = Object.freeze({ available: true } as const);

const clipboardKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'clipboard is supported on Apple simulators and the macOS host.',
} as const);
const settingsKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'settings is supported on Apple simulators and the macOS host.',
} as const);
const settingsLeafUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'settings is supported on Apple simulators and the macOS host, not on physical devices of this OS.',
} as const);
const settingUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Run `agent-device settings --help` for the settings each target serves.',
} as const);
const macOsSettingUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'The macOS host supports settings appearance and settings permission <grant|reset> <accessibility|screen-recording|input-monitoring>.',
} as const);
/** Content size and BiometricKit_Sim notifications answer only on iPhone and iPad simulators. */
const handheldSimulatorUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Select a booted iPhone or iPad simulator: this setting runs only there.',
} as const);
/**
 * Parity with the retired `supportsHostOrSimulatorSurface` closure: the Apple pasteboard is
 * reachable on any simulator (read through `simctl pbpaste`, written by the runner or, on tvOS,
 * `simctl pbcopy`) and directly on the macOS host; a physical iOS/iPadOS/tvOS/visionOS device has
 * neither route.
 */
const clipboardLeafUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'clipboard is supported on Apple simulators and the macOS host, not on physical devices of this OS.',
} as const);
/**
 * watchOS has no XCUITest-driveable UI (ADR-0009), so no Apple interactor can be constructed for
 * it and every interactor-backed operation stays unavailable there — the same reading
 * `appleBackFact` takes, and for the same reason: facts are the support authority, not a mirror
 * of a capability table that never modeled interactor constructibility.
 */
const appleWatchOsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);

/**
 * The one host-or-simulator reading `clipboard` and `settings` share, and sharing it is parity
 * rather than convenience: the retired `supportsHostOrSimulatorSurface` closure gated both off
 * the same per-AppleOS `physicalDeviceSurfaces` row. Only the refusal wording differs, so each
 * caller supplies its own pair.
 */
function appleHostOrSimulatorFact(
  device: DeviceInfo,
  kindUnavailable: RuntimeOperationFact,
  leafUnavailable: RuntimeOperationFact,
): RuntimeOperationFact {
  if (device.kind !== 'simulator' && device.kind !== 'device') return kindUnavailable;
  const os = resolveDeviceAppleOs(device);
  if (os === 'watchos') return appleWatchOsUnavailable;
  if (device.kind === 'simulator') return available;
  return os === 'macos' ? available : leafUnavailable;
}

/**
 * Read and write share one cell: both routes (the simulator's `simctl pbpaste` read with its
 * runner write, or `simctl pbcopy` on tvOS, and the macOS host pasteboard) expose the pair or
 * neither, so splitting them here would invent a cell no Apple owner can actually be in.
 */
function appleClipboardFact(device: DeviceInfo): RuntimeOperationFact {
  return appleHostOrSimulatorFact(device, clipboardKindUnavailable, clipboardLeafUnavailable);
}

const appEventKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'trigger-app-event is supported on Apple simulators and physical devices.',
} as const);

const alertKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'alert is supported on Apple simulators and physical devices.',
} as const);
const alertLeafUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'alert is supported on Apple simulators, the macOS host, and physical iOS devices.',
} as const);

/**
 * Parity with the retired `supportsAlertSurface` closure, which was the host-or-simulator reading
 * widened by one leaf: physical iOS, whose XCTest alert path is device-verified. iPadOS,
 * tvOS and visionOS devices stay closed exactly as that closure left them — not because the
 * runner could not reach them, but because nobody has verified it there.
 */
function appleAlertFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.kind !== 'simulator' && device.kind !== 'device') return alertKindUnavailable;
  const os = resolveDeviceAppleOs(device);
  if (os === 'watchos') return appleWatchOsUnavailable;
  if (device.kind === 'simulator' || os === 'ios' || os === 'macos') return available;
  return alertLeafUnavailable;
}

/**
 * No apple-family closure ever gated `trigger-app-event` beyond its capability bucket
 * (`{ simulator, device }`): the deep link opens through the same interactor `open` every Apple
 * leaf drives. watchOS is the one narrowing, for want of a constructible interactor at all.
 */
function appleAppEventFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.kind !== 'simulator' && device.kind !== 'device') return appEventKindUnavailable;
  return resolveDeviceAppleOs(device) === 'watchos' ? appleWatchOsUnavailable : available;
}

/**
 * The clipboard denial this leaf reports for a half it does not name: the leaf's own refusal where
 * it has one, since a leaf that serves clipboard today has no clipboard refusal to state.
 */
function appleClipboardFamilyUnavailable(device: DeviceInfo): RuntimeOperationUnavailability {
  const cell = appleClipboardFact(device);
  return cell.available ? clipboardLeafUnavailable : cell;
}

function appleSettingsFacts(device: DeviceInfo) {
  const target = appleHostOrSimulatorFact(device, settingsKindUnavailable, settingsLeafUnavailable);
  if (isMacOs(device)) {
    return settingsRuntimeOperationFacts({
      target,
      unsupported: macOsSettingUnavailable,
      write: {
        appearance: available,
        permission: available,
      } satisfies Record<MacOsHostSetting, RuntimeOperationFact>,
    });
  }
  const handheld = isHandheldAppleSimulator(device) ? available : handheldSimulatorUnavailable;
  return settingsRuntimeOperationFacts({
    target,
    unsupported: settingUnavailable,
    write: {
      wifi: available,
      airplane: available,
      location: available,
      appearance: available,
      'clear-app-state': available,
      'reset-keychain': available,
      permission: available,
      'text-size': handheld,
      faceid: handheld,
      touchid: handheld,
    } satisfies Record<AppleSimulatorSetting, RuntimeOperationFact>,
    read: { 'text-size': handheld },
  });
}

/** The system-surface cells: clipboard read/write, app-event delivery, settings, and alerts. */
export function appleSystemFacts(device: DeviceInfo) {
  const clipboard = appleClipboardFact(device);
  // The four alert legs share one cell: an Apple leaf whose backend can read an alert can also
  // press its buttons, so splitting them would invent a cell no Apple owner is ever in.
  const alert = appleAlertFact(device);
  return Object.freeze({
    ...clipboardRuntimeOperationFacts({
      unsupported: appleClipboardFamilyUnavailable(device),
      read: clipboard,
      write: clipboard,
    }),
    ...alertRuntimeOperationFacts({ read: alert, wait: alert, accept: alert, dismiss: alert }),
    ...appEventRuntimeOperationFacts({ triggerAppEvent: appleAppEventFact(device) }),
    ...appleSettingsFacts(device),
  });
}

/** Binds whichever system operations {@link appleSystemFacts} admitted. */
export function createAppleSystemOperations(params: {
  host: Pick<PlatformRuntimeHost, 'localInteractors'>;
  device: DeviceInfo;
  signal: AbortSignal;
}) {
  const { host, device, signal } = params;
  return bindAdmittedLocalInteractorOperations({
    device,
    signal,
    resolveInteractor: host.localInteractors.resolve,
    facts: appleSystemFacts(device),
  });
}
