import type { DeviceInfo } from '@agent-device/kernel/device';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import { elementTextRuntimeOperationFacts } from '@agent-device/contracts/element-text-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { RuntimeFacts } from '@agent-device/contracts/platform-runtime';
import { screenshotRuntimeOperationFacts } from '@agent-device/contracts/screenshot-runtime';
import { selectorObservationRuntimeOperationFacts } from '@agent-device/contracts/selector-observation-runtime';
import { snapshotRuntimeOperationFacts } from '@agent-device/contracts/snapshot-runtime';
import { viewportRuntimeOperationFacts } from '@agent-device/contracts/viewport-runtime';
import { audioProbeRuntimeOperationFacts } from '@agent-device/contracts/audio-probe-runtime';
import { perfRuntimeOperationFacts } from '@agent-device/contracts/perf-runtime';
import type { DoublespeedPlatformRuntimeOwnerOptions } from './app-log-runtime.ts';
import { isSupportedDoublespeedDevice } from './device.ts';
import {
  doublespeedAppDeploymentFacts,
  type DoublespeedAppDeploymentRuntimeOptions,
} from './deployment-runtime.ts';
import {
  doublespeedAlertOperationFacts,
  doublespeedAppEventOperationFacts,
  doublespeedAppSwitcherOperationFacts,
  doublespeedClipboardOperationFacts,
  doublespeedInteractionOperationFacts,
  doublespeedKeyboardOperationFacts,
  doublespeedNavigationOperationFacts,
  doublespeedSettingsOperationFacts,
} from './interaction-operations.ts';
import { DOUBLESPEED_PORT_REVERSE_UNSUPPORTED } from './lifecycle.ts';

const available = Object.freeze({ available: true } as const);
const viewportUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Doublespeed does not expose viewport resizing.',
} as const);
/**
 * A point read needs a local tool (the XCUITest runner). The session transport carries none, so
 * the owner reports no live read and `get` answers from the captured tree.
 */
const elementTextUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Doublespeed-owned devices read element text from the captured tree only.',
} as const);
const observationUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Doublespeed-owned devices poll the captured tree instead of a native selector read.',
} as const);
const recordingUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Doublespeed does not expose an exact-owner screen-recording runtime.',
} as const);
const headlessUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Headless boot is unavailable for provider-owned devices.',
} as const);
/** Also read by the owner's `inspectFacts` for a device with no matching live session at all. */
export const liveSessionUnavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'Doublespeed requires a matching live provider session for this device.',
} as const);
const prepareUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Apple runner preparation is unavailable for Doublespeed-owned devices.',
} as const);
const openTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Doublespeed open requires a Doublespeed-owned iOS simulator.',
} as const);
const closeTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Doublespeed close requires a Doublespeed-owned iOS simulator.',
} as const);
const runtimeHintsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Runtime hints are not applied to provider-owned devices.',
} as const);
const portReverseUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: DOUBLESPEED_PORT_REVERSE_UNSUPPORTED,
} as const);
const audioProbeUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Doublespeed does not expose the audio probe.',
} as const);
const shutdownTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Doublespeed owns the target lifecycle for provider-owned devices.',
} as const);

/** Also read by the owner's `bind`: it needs the same deployment options its facts do. */
export function deploymentOptions(
  options: DoublespeedPlatformRuntimeOwnerOptions,
): DoublespeedAppDeploymentRuntimeOptions {
  return { ...options, isSessionActive: options.hasLiveSession };
}

/** Also read by the owner's `inspectFacts` for the not-live-session fallback. */
export function doublespeedLifecycleFacts(device: DeviceInfo, live: boolean) {
  const supported = isSupportedDoublespeedDevice(device);
  const openTarget = supported
    ? live
      ? available
      : liveSessionUnavailable
    : openTargetUnavailable;
  const closeTarget = supported
    ? live
      ? available
      : liveSessionUnavailable
    : closeTargetUnavailable;
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: openTarget,
    prepareApplicationOpen: openTarget,
    openApplication: openTarget,
    applyRuntimeHints: runtimeHintsUnavailable,
    clearRuntimeHints: runtimeHintsUnavailable,
    closeApplication: closeTarget,
    finalizeApplicationClose: closeTarget,
    prepareAppleRunner: prepareUnavailable,
    configureProviderPortReverse: live ? portReverseUnavailable : liveSessionUnavailable,
  });
}

export function doublespeedRuntimeFacts(
  options: DoublespeedPlatformRuntimeOwnerOptions,
  device: DeviceInfo,
): RuntimeFacts<PlatformRuntimeOperations> {
  const deployment = doublespeedAppDeploymentFacts(deploymentOptions(options), device);
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
      appState: available,
      networkDump: available,
      screenRecordingStart: recordingUnavailable,
      screenRecordingReattach: recordingUnavailable,
      screenRecordingCleanup: recordingUnavailable,
      ...snapshotRuntimeOperationFacts({
        capture: available,
        customActions: available,
        withoutActiveApp: available,
      }),
      ...screenshotRuntimeOperationFacts({ capture: available }),
      ...selectorObservationRuntimeOperationFacts({
        findText: observationUnavailable,
        findSelector: observationUnavailable,
      }),
      ...viewportRuntimeOperationFacts({ setViewport: viewportUnavailable }),
      ...doublespeedInteractionOperationFacts(device),
      ...elementTextRuntimeOperationFacts({ readTextAtPoint: elementTextUnavailable }),
      ...doublespeedNavigationOperationFacts(device),
      ...doublespeedKeyboardOperationFacts(device),
      ...doublespeedClipboardOperationFacts(device),
      ...doublespeedAppSwitcherOperationFacts(device),
      ...doublespeedAppEventOperationFacts(device),
      ...doublespeedSettingsOperationFacts(device),
      ...doublespeedAlertOperationFacts(device),
      ...audioProbeRuntimeOperationFacts({
        capture: audioProbeUnavailable,
        query: audioProbeUnavailable,
      }),
      ...perfRuntimeOperationFacts({
        frames: elementTextUnavailable,
        memorySample: elementTextUnavailable,
        memorySnapshot: elementTextUnavailable,
        nativeCapture: elementTextUnavailable,
        profileReport: elementTextUnavailable,
      }),
      ensureReady: available,
      bootTarget: available,
      bootTargetHeadless: headlessUnavailable,
      listApps: available,
      shutdownTarget: shutdownTargetUnavailable,
      ...doublespeedLifecycleFacts(device, true),
    },
  });
}

export function doublespeedRecoveryFacts(
  options: DoublespeedPlatformRuntimeOwnerOptions,
  device: DeviceInfo,
): RuntimeFacts<PlatformRuntimeOperations> {
  const normalFacts = doublespeedRuntimeFacts(options, device);
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
      ...doublespeedInteractionOperationFacts(device, liveSessionUnavailable),
      ...doublespeedNavigationOperationFacts(device, liveSessionUnavailable),
      ...doublespeedKeyboardOperationFacts(device, liveSessionUnavailable),
      ...doublespeedClipboardOperationFacts(device, liveSessionUnavailable),
      ...doublespeedAppSwitcherOperationFacts(device, liveSessionUnavailable),
      ...doublespeedAppEventOperationFacts(device, liveSessionUnavailable),
      ...doublespeedSettingsOperationFacts(device, liveSessionUnavailable),
      ...doublespeedAlertOperationFacts(device, liveSessionUnavailable),
      ensureReady: liveSessionUnavailable,
      bootTarget: liveSessionUnavailable,
      bootTargetHeadless: liveSessionUnavailable,
      listApps: liveSessionUnavailable,
      deployApp: liveSessionUnavailable,
      materializeAppSource: liveSessionUnavailable,
      deployMaterializedApp: liveSessionUnavailable,
      sendPushNotification: liveSessionUnavailable,
      shutdownTarget: liveSessionUnavailable,
      ...doublespeedLifecycleFacts(device, false),
    },
  });
}
