import { createUnavailablePlatformRuntimeFacts } from '@agent-device/contracts/platform-runtime-unavailable';
import {
  providerRuntimeOwner,
  type RuntimeFacts,
  unavailableFact,
} from '@agent-device/contracts/platform-runtime';
import { invalidRuntimeContract } from '@agent-device/contracts/runtime-contract-error';
import { deviceShape, isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import { elementTextRuntimeOperationFacts } from '@agent-device/contracts/element-text-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { screenshotRuntimeOperationFacts } from '@agent-device/contracts/screenshot-runtime';
import { selectorObservationRuntimeOperationFacts } from '@agent-device/contracts/selector-observation-runtime';
import { snapshotRuntimeOperationFacts } from '@agent-device/contracts/snapshot-runtime';
import { viewportRuntimeOperationFacts } from '@agent-device/contracts/viewport-runtime';
import { audioProbeRuntimeOperationFacts } from '@agent-device/contracts/audio-probe-runtime';
import { perfRuntimeOperationFacts } from '@agent-device/contracts/perf-runtime';
import type { LimrunPlatformRuntimeOwnerOptions } from './app-log-runtime.ts';
import { isSupportedLimrunAppLogDevice } from './device.ts';
import {
  limrunAppDeploymentFacts,
  type LimrunAppDeploymentRuntimeOptions,
} from './deployment-runtime.ts';
import {
  limrunAndroidInteractionFacts,
  limrunAndroidSettingsFacts,
  limrunAppleSettingsFacts,
  LIMRUN_FOLD_UNAVAILABLE,
  LIMRUN_TELEPHONY_UNAVAILABLE,
} from './interaction-operations.ts';

const available = Object.freeze({ available: true } as const);
const customSnapshotUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Custom snapshot actions are available only for Limrun iOS simulator sessions.',
);
const viewportUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Limrun does not expose viewport resizing.',
);
const elementTextUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Read element text from the captured snapshot.',
);
const headlessUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Headless boot is unavailable for provider-owned devices.',
);
/** Also read outside this module's own facts assembly: the owner's `inspectFacts` reports this
 * for every operation when the request names a device with no matching live session at all. */
export const liveSessionUnavailable = unavailableFact(
  'owner-capability-missing',
  'Limrun requires a matching live provider session for this device.',
);
const prepareUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Apple runner preparation is unavailable for Limrun-owned devices.',
);
const openTargetUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Limrun open requires a Limrun-owned iOS simulator or Android emulator.',
);
const closeTargetUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Limrun close requires a Limrun-owned iOS simulator or Android emulator.',
);
const runtimeHintsUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Runtime hints are not applied to provider-owned devices.',
);
const portReverseUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Limrun port reverse requires an active Android Limrun session.',
);
const audioProbeUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Limrun does not expose the audio probe.',
);

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
    applyRuntimeHints:
      isIosFamily(device) && openTarget.available ? available : runtimeHintsUnavailable,
    clearRuntimeHints:
      isIosFamily(device) && openTarget.available ? available : runtimeHintsUnavailable,
    closeApplication: closeTarget,
    finalizeApplicationClose: closeTarget,
    prepareAppleRunner:
      isIosFamily(device) && openTarget.available ? available : prepareUnavailable,
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
  const runner = options.getIosRunner(device);
  if (!isAndroid && !runner) throw invalidRuntimeContract('Limrun iOS session has no Apple runner');
  const interactionFacts = isAndroid ? limrunAndroidInteractionFacts(device) : runner!.facts;
  return Object.freeze({
    device: { ...deviceShape(device), providerMode: 'provider-runtime' },
    operations: {
      ...limrunUnavailableFacts(options, device).operations,
      appLogInspect: available,
      appLogDoctor: available,
      appLogStart: available,
      appLogReattach: available,
      appLogCleanup: available,
      ...deployment,
      ...(isAndroid ? { appState: available } : {}),
      networkDump: available,
      screenRecordingStart: available,
      screenRecordingReattach: available,
      screenRecordingCleanup: available,
      ...(isAndroid
        ? {
            ...snapshotRuntimeOperationFacts({
              capture: available,
              customActions: customSnapshotUnavailable,
              withoutActiveApp: available,
            }),
            ...selectorObservationRuntimeOperationFacts({
              findText: customSnapshotUnavailable,
              querySelector: customSnapshotUnavailable,
            }),
            ...elementTextRuntimeOperationFacts({ readTextAtPoint: available }),
          }
        : {}),
      ...screenshotRuntimeOperationFacts({ capture: available }),
      ...viewportRuntimeOperationFacts({ setViewport: viewportUnavailable }),
      ...limrunLifecycleFacts(device, true),
      ...interactionFacts,
      setFoldPose: LIMRUN_FOLD_UNAVAILABLE,
      sendTelephonyEvent: LIMRUN_TELEPHONY_UNAVAILABLE,
      ...(isAndroid ? limrunAndroidSettingsFacts() : limrunAppleSettingsFacts(interactionFacts)),
      ...audioProbeRuntimeOperationFacts({
        capture: audioProbeUnavailable,
        query: audioProbeUnavailable,
      }),
      ...perfRuntimeOperationFacts({
        frames: isAndroid ? available : elementTextUnavailable,
        memorySample: isAndroid ? available : elementTextUnavailable,
        memorySnapshot: isAndroid ? available : elementTextUnavailable,
        nativeCapture: elementTextUnavailable,
        profileReport: elementTextUnavailable,
      }),
      ensureReady: available,
      bootTarget: available,
      bootTargetHeadless: headlessUnavailable,
      listApps: available,
      shutdownTarget: available,
    },
  });
}

export function limrunAppLogRecoveryFacts(
  options: LimrunPlatformRuntimeOwnerOptions,
  device: DeviceInfo,
): RuntimeFacts<PlatformRuntimeOperations> {
  const facts = limrunUnavailableFacts(options, device);
  return {
    device: facts.device,
    operations: { ...facts.operations, appLogReattach: available, appLogCleanup: available },
  };
}

export function limrunUnavailableFacts(
  options: LimrunPlatformRuntimeOwnerOptions,
  device: DeviceInfo,
) {
  const owner = providerRuntimeOwner('limrun', options.runtimeInstance);
  return createUnavailablePlatformRuntimeFacts(device, owner, {
    appLog: liveSessionUnavailable,
    appState: liveSessionUnavailable,
    appDeployment: liveSessionUnavailable,
    network: liveSessionUnavailable,
    screenshot: liveSessionUnavailable,
    viewport: liveSessionUnavailable,
    focus: liveSessionUnavailable,
    gesture: liveSessionUnavailable,
    scroll: liveSessionUnavailable,
    typeText: liveSessionUnavailable,
    touch: liveSessionUnavailable,
    elementText: liveSessionUnavailable,
    back: liveSessionUnavailable,
    orientation: liveSessionUnavailable,
    tvRemote: liveSessionUnavailable,
    keyboard: liveSessionUnavailable,
    clipboard: liveSessionUnavailable,
    systemButton: liveSessionUnavailable,
    fold: LIMRUN_FOLD_UNAVAILABLE,
    telephony: LIMRUN_TELEPHONY_UNAVAILABLE,
    triggerAppEvent: liveSessionUnavailable,
    settings: liveSessionUnavailable,
    readAlert: liveSessionUnavailable,
    awaitAlert: liveSessionUnavailable,
    acceptAlert: liveSessionUnavailable,
    dismissAlert: liveSessionUnavailable,
    audioProbeCapture: liveSessionUnavailable,
    audioProbeQuery: liveSessionUnavailable,
    perf: liveSessionUnavailable,
    readiness: liveSessionUnavailable,
    shutdown: liveSessionUnavailable,
    lifecycle: limrunLifecycleFacts(device, false),
  });
}
