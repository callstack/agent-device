import { appEventRuntimeOperationFacts } from '@agent-device/contracts/app-event-runtime';
import { clipboardRuntimeOperationFacts } from '@agent-device/contracts/clipboard-runtime';
import { bindAdmittedLocalInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { resolveDeviceAppleOs, type DeviceInfo } from '@agent-device/kernel/device';

const available = Object.freeze({ available: true } as const);

const clipboardKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'clipboard is supported on Apple simulators and the macOS host.',
} as const);
/**
 * Parity with the retired `supportsHostOrSimulatorSurface` closure: the Apple pasteboard is
 * reachable through `simctl pbpaste`/`pbcopy` on any simulator, and directly on the macOS host;
 * a physical iOS/iPadOS/tvOS/visionOS device has neither route.
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
const clipboardOsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);

/**
 * Read and write share one cell: both routes (`simctl pbpaste`/`pbcopy`, and the macOS host
 * pasteboard) expose the pair or neither, so splitting them here would invent a cell no Apple
 * owner can actually be in.
 */
function appleClipboardFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.kind !== 'simulator' && device.kind !== 'device') return clipboardKindUnavailable;
  const os = resolveDeviceAppleOs(device);
  if (os === 'watchos') return clipboardOsUnavailable;
  if (device.kind === 'simulator') return available;
  return os === 'macos' ? available : clipboardLeafUnavailable;
}

const appEventKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'trigger-app-event is supported on Apple simulators and physical devices.',
} as const);

/**
 * No apple-family closure ever gated `trigger-app-event` beyond its capability bucket
 * (`{ simulator, device }`): the deep link opens through the same interactor `open` every Apple
 * leaf drives. watchOS is the one narrowing, for want of a constructible interactor at all.
 */
function appleAppEventFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.kind !== 'simulator' && device.kind !== 'device') return appEventKindUnavailable;
  return resolveDeviceAppleOs(device) === 'watchos' ? clipboardOsUnavailable : available;
}

/** The system-surface cells: clipboard read/write and app-event delivery. */
export function appleSystemFacts(device: DeviceInfo) {
  const clipboard = appleClipboardFact(device);
  return Object.freeze({
    ...clipboardRuntimeOperationFacts({ read: clipboard, write: clipboard }),
    ...appEventRuntimeOperationFacts({ triggerAppEvent: appleAppEventFact(device) }),
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
