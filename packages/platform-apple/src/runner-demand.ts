import type { OpenApplicationRunnerDemand } from '@agent-device/contracts/application-lifecycle-runtime';
import type { RuntimeOperationKey } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';

/**
 * Which host the Apple runtime executes each declared runtime operation through on a local iOS
 * Simulator. `runner` operations need the XCTest runner; `simulator` operations are served by
 * simctl, the host AX bridge, or host-side tooling and never wait for runner readiness.
 *
 * Bridge-eligible snapshots keep their typed XCTest fallback, but a fallback is a recovery, not a
 * plan requirement, so they classify as `simulator`. The record is complete over the runtime
 * operation union by construction: a new operation refuses to compile until it is classified.
 */
type AppleSimulatorOperationHost = 'runner' | 'simulator';

const APPLE_SIMULATOR_OPERATION_HOSTS: Readonly<
  Record<RuntimeOperationKey<PlatformRuntimeOperations>, AppleSimulatorOperationHost>
> = Object.freeze({
  // Application lifecycle: simctl launch/terminate and host readiness.
  resolveOpenTarget: 'simulator',
  prepareApplicationOpen: 'simulator',
  openApplication: 'simulator',
  applyRuntimeHints: 'simulator',
  clearRuntimeHints: 'simulator',
  closeApplication: 'simulator',
  finalizeApplicationClose: 'simulator',
  prepareAppleRunner: 'runner',
  configureProviderPortReverse: 'simulator',
  ensureReady: 'simulator',
  bootTarget: 'simulator',
  bootTargetHeadless: 'simulator',
  shutdownTarget: 'simulator',
  // App inventory, deployment, state, logs, network, audio: simctl and host tooling.
  listApps: 'simulator',
  deployApp: 'simulator',
  materializeAppSource: 'simulator',
  deployMaterializedApp: 'simulator',
  sendPushNotification: 'simulator',
  appState: 'simulator',
  appLogStart: 'simulator',
  appLogInspect: 'simulator',
  appLogDoctor: 'simulator',
  appLogReattach: 'simulator',
  appLogCleanup: 'simulator',
  networkDump: 'simulator',
  audioProbeStart: 'simulator',
  audioProbeQuery: 'simulator',
  audioProbeReattach: 'simulator',
  audioProbeCleanup: 'simulator',
  readClipboard: 'simulator',
  writeClipboard: 'simulator',
  setSetting: 'simulator',
  // Observation: the AX bridge presents regular and raw trees; custom actions need XCTest.
  captureSnapshot: 'simulator',
  captureSnapshotWithoutActiveApp: 'simulator',
  captureSnapshotWithCustomActions: 'runner',
  captureScreenshot: 'simulator',
  findText: 'simulator',
  findSelector: 'simulator',
  readTextAtPoint: 'runner',
  // Every interaction and runner-driven capture.
  tapPoint: 'runner',
  tapRef: 'runner',
  tapElementSelector: 'runner',
  fillPoint: 'runner',
  fillRef: 'runner',
  longPressPoint: 'runner',
  hoverPoint: 'runner',
  hoverRef: 'runner',
  focusPoint: 'runner',
  typeText: 'runner',
  scrollDirection: 'runner',
  performGesturePlan: 'runner',
  performMultiTouchGesturePlan: 'runner',
  performTargetAuthoredDrag: 'runner',
  performDirectionalFlingPlan: 'runner',
  gestureViewport: 'runner',
  setViewport: 'runner',
  back: 'runner',
  home: 'runner',
  setOrientation: 'runner',
  appSwitcher: 'runner',
  tvRemote: 'runner',
  keyboardDismiss: 'runner',
  keyboardEnter: 'runner',
  keyboardStatus: 'runner',
  triggerAppEvent: 'runner',
  readAlert: 'runner',
  awaitAlert: 'runner',
  acceptAlert: 'runner',
  dismissAlert: 'runner',
  perfFrames: 'runner',
  perfMemorySample: 'runner',
  perfMemorySnapshot: 'runner',
  perfNativeCaptureStart: 'runner',
  perfNativeCaptureReattach: 'runner',
  perfNativeCaptureCleanup: 'runner',
  perfProfileReport: 'runner',
  screenRecordingStart: 'runner',
  screenRecordingReattach: 'runner',
  screenRecordingCleanup: 'runner',
});

/**
 * The runner demand of one local-Simulator open. An unknown plan keeps today's speculative
 * prewarm; a plan whose required operations are all simulator-served proves no runner is needed;
 * any runner-served operation makes readiness worth preparing now.
 */
export function resolveAppleSimulatorRunnerDemand(
  operations: readonly RuntimeOperationKey<PlatformRuntimeOperations>[] | undefined,
): OpenApplicationRunnerDemand {
  if (operations === undefined) return 'possible';
  return operations.some((operation) => APPLE_SIMULATOR_OPERATION_HOSTS[operation] === 'runner')
    ? 'required'
    : 'none';
}
