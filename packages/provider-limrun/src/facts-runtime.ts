import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import { elementTextRuntimeOperationFacts } from '@agent-device/contracts/element-text-runtime';
import type { PlatformRuntimeOperations, RuntimeFacts } from '@agent-device/contracts/platform';
import { screenshotRuntimeOperationFacts } from '@agent-device/contracts/screenshot-runtime';
import { selectorObservationRuntimeOperationFacts } from '@agent-device/contracts/selector-observation-runtime';
import { snapshotRuntimeOperationFacts } from '@agent-device/contracts/snapshot-runtime';
import { viewportRuntimeOperationFacts } from '@agent-device/contracts/viewport-runtime';
import type { LimrunPlatformRuntimeOwnerOptions } from './app-log-runtime.ts';
import { isSupportedLimrunAppLogDevice } from './device.ts';
import {
  limrunAppDeploymentFacts,
  type LimrunAppDeploymentRuntimeOptions,
} from './deployment-runtime.ts';
import {
  limrunInteractionOperationFacts,
  limrunKeyboardOperationFacts,
  limrunNavigationOperationFacts,
} from './interaction-operations.ts';

const available = Object.freeze({ available: true } as const);
const customSnapshotUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Custom snapshot actions are available only for Limrun iOS simulator sessions.',
} as const);
const viewportUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun does not expose viewport resizing.',
} as const);
/**
 * A point read needs a local tool (adb uiautomator, the XCUITest runner). Limrun's transport
 * carries none of them, so the owner reports no live read and `get` answers from the captured
 * tree; provider ownership never borrows the local family read.
 */
const elementTextUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun-owned devices read element text from the captured tree only.',
} as const);
const recordingUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun does not expose an exact-owner screen-recording runtime.',
} as const);
const headlessUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Headless boot is unavailable for provider-owned devices.',
} as const);
/** Also read outside this module's own facts assembly: the owner's `inspectFacts` reports this
 * for every operation when the request names a device with no matching live session at all. */
export const liveSessionUnavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'Limrun requires a matching live provider session for this device.',
} as const);
const prepareUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Apple runner preparation is unavailable for Limrun-owned devices.',
} as const);
const iosAppStateUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun iOS appstate is session-owned; no sessionless provider foreground probe is exposed.',
} as const);
const openTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun open requires a Limrun-owned iOS simulator or Android emulator.',
} as const);
const closeTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun close requires a Limrun-owned iOS simulator or Android emulator.',
} as const);
const runtimeHintsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Runtime hints are not applied to provider-owned devices.',
} as const);
const portReverseUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun port reverse requires an active Android Limrun session.',
} as const);

/** Also read outside this module's own facts assembly: the owner's `bind` needs the same
 * deployment options its facts do. */
export function deploymentOptions(
  options: LimrunPlatformRuntimeOwnerOptions,
): LimrunAppDeploymentRuntimeOptions {
  return { ...options, isSessionActive: options.hasLiveSession };
}

/** Also read outside this module's own facts assembly: the owner's `inspectFacts` reports this
 * for the not-live-session fallback too. */
export function limrunLifecycleFacts(device: DeviceInfo, live: boolean) {
  const openTarget = limrunOpenTargetFact(device, live);
  const closeTarget = limrunCloseTargetFact(device, live);
  const portReverse = limrunPortReverseFact(device, live);
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: openTarget,
    prepareApplicationOpen: openTarget,
    openApplication: openTarget,
    applyRuntimeHints: runtimeHintsUnavailable,
    clearRuntimeHints: runtimeHintsUnavailable,
    closeApplication: closeTarget,
    finalizeApplicationClose: closeTarget,
    prepareAppleRunner: prepareUnavailable,
    configureProviderPortReverse: portReverse,
  });
}

function limrunOpenTargetFact(device: DeviceInfo, live: boolean) {
  return isSupportedLimrunAppLogDevice(device)
    ? live
      ? available
      : liveSessionUnavailable
    : openTargetUnavailable;
}

function limrunCloseTargetFact(device: DeviceInfo, live: boolean) {
  return isSupportedLimrunAppLogDevice(device)
    ? live
      ? available
      : liveSessionUnavailable
    : closeTargetUnavailable;
}

function limrunPortReverseFact(device: DeviceInfo, live: boolean) {
  if (!live) return liveSessionUnavailable;
  return device.platform === 'android' ? available : portReverseUnavailable;
}

export function limrunAppLogFacts(
  options: LimrunPlatformRuntimeOwnerOptions,
  device: DeviceInfo,
): RuntimeFacts<PlatformRuntimeOperations> {
  const deployment = limrunAppDeploymentFacts(deploymentOptions(options), device);
  const isAndroid = device.platform === 'android';
  const customSnapshotFact =
    isIosFamily(device) && device.kind === 'simulator' ? available : customSnapshotUnavailable;
  return Object.freeze({
    device: {
      family: device.platform,
      ...(device.appleOs === undefined ? {} : { appleOs: device.appleOs }),
      kind: device.kind,
      ...(device.target === undefined ? {} : { target: device.target }),
      ...(device.iosPhysicalDeviceBackend === undefined
        ? {}
        : { iosPhysicalDeviceBackend: device.iosPhysicalDeviceBackend }),
      providerMode: 'provider-runtime',
    },
    operations: {
      appLogInspect: available,
      appLogDoctor: available,
      appLogStart: available,
      appLogReattach: available,
      appLogCleanup: available,
      ...deployment,
      appState: isAndroid ? available : iosAppStateUnavailable,
      networkDump: available,
      screenRecordingStart: recordingUnavailable,
      screenRecordingReattach: recordingUnavailable,
      screenRecordingCleanup: recordingUnavailable,
      ...snapshotRuntimeOperationFacts({
        capture: available,
        customActions: customSnapshotFact,
        withoutActiveApp: available,
      }),
      ...screenshotRuntimeOperationFacts({ capture: available }),
      // Provider ownership is authoritative: no native text reading is exposed, so text waits
      // on a Limrun-owned device poll the canonical tree rather than borrowing Apple's.
      ...selectorObservationRuntimeOperationFacts({
        findText: customSnapshotUnavailable,
        findSelector: customSnapshotUnavailable,
      }),
      ...viewportRuntimeOperationFacts({ setViewport: viewportUnavailable }),
      // Focus rides the same provider interactor the captures do, and a live-session Limrun
      // device always has one, so it is available wherever a capture is.
      ...limrunInteractionOperationFacts(device),
      ...elementTextRuntimeOperationFacts({ readTextAtPoint: elementTextUnavailable }),
      ...limrunNavigationOperationFacts(device),
      ...limrunKeyboardOperationFacts(device),
      ensureReady: available,
      bootTarget: available,
      bootTargetHeadless: headlessUnavailable,
      listApps: available,
      shutdownTarget: {
        available: false,
        reason: 'unsupported-provider-mode',
        hint: 'Limrun owns the target lifecycle for provider-owned devices.',
      },
      ...limrunLifecycleFacts(device, true),
    },
  });
}

export function limrunAppLogRecoveryFacts(
  options: LimrunPlatformRuntimeOwnerOptions,
  device: DeviceInfo,
): RuntimeFacts<PlatformRuntimeOperations> {
  const normalFacts = limrunAppLogFacts(options, device);
  return Object.freeze({
    device: normalFacts.device,
    operations: {
      ...normalFacts.operations,
      appLogInspect: liveSessionUnavailable,
      appLogDoctor: liveSessionUnavailable,
      appLogStart: liveSessionUnavailable,
      appLogReattach: available,
      appLogCleanup: available,
      appState: liveSessionUnavailable,
      networkDump: liveSessionUnavailable,
      screenRecordingStart: liveSessionUnavailable,
      screenRecordingReattach: liveSessionUnavailable,
      screenRecordingCleanup: liveSessionUnavailable,
      ...snapshotRuntimeOperationFacts({
        capture: liveSessionUnavailable,
        customActions: liveSessionUnavailable,
        withoutActiveApp: liveSessionUnavailable,
      }),
      ...screenshotRuntimeOperationFacts({ capture: liveSessionUnavailable }),
      ...selectorObservationRuntimeOperationFacts({
        findText: liveSessionUnavailable,
        findSelector: liveSessionUnavailable,
      }),
      ...viewportRuntimeOperationFacts({ setViewport: liveSessionUnavailable }),
      ...limrunInteractionOperationFacts(device, liveSessionUnavailable),
      ...limrunNavigationOperationFacts(device, liveSessionUnavailable),
      ...limrunKeyboardOperationFacts(device, liveSessionUnavailable),
      ensureReady: liveSessionUnavailable,
      bootTarget: liveSessionUnavailable,
      bootTargetHeadless: liveSessionUnavailable,
      listApps: liveSessionUnavailable,
      deployApp: liveSessionUnavailable,
      materializeAppSource: liveSessionUnavailable,
      deployMaterializedApp: liveSessionUnavailable,
      sendPushNotification: liveSessionUnavailable,
      shutdownTarget: liveSessionUnavailable,
      ...limrunLifecycleFacts(device, false),
    },
  });
}
