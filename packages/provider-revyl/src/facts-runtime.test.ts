import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { revylFacts, revylLifecycleFacts } from './facts-runtime.ts';
import { liveSessionUnavailable } from './interaction-operations.ts';

const IOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'revyl:ios:lease-1',
  name: 'Revyl ios run-1',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

type RevylOperation = keyof ReturnType<typeof revylFacts>['operations'];

/**
 * Every operation cell Revyl's facts report, with the verdict each one has to carry. `available` is
 * a cell the facts admit; `mode` is a cell refused because the worker has no action for it; `kind` is
 * a cell refused because the rented device is the wrong shape for the command at all.
 *
 * The map is typed over the whole catalog, so a cell added to or dropped from `revylFacts` is a
 * compile error here rather than an unclassified row.
 */
const EXPECTED_CELLS = {
  back: 'available',
  bootTarget: 'available',
  captureScreenshot: 'available',
  captureSnapshot: 'available',
  captureSnapshotWithoutActiveApp: 'available',
  closeApplication: 'available',
  ensureReady: 'available',
  fillPoint: 'available',
  finalizeApplicationClose: 'available',
  focusPoint: 'available',
  home: 'available',
  longPressPoint: 'available',
  openApplication: 'available',
  prepareApplicationOpen: 'available',
  resolveOpenTarget: 'available',
  scrollDirection: 'available',
  tapPoint: 'available',

  acceptAlert: 'mode',
  actionButton: 'mode',
  appLogCleanup: 'mode',
  appLogDoctor: 'mode',
  appLogInspect: 'mode',
  appLogReattach: 'mode',
  appLogStart: 'mode',
  appState: 'mode',
  appSwitcher: 'mode',
  applyRuntimeHints: 'mode',
  audioProbeCleanup: 'mode',
  audioProbeQuery: 'mode',
  audioProbeReattach: 'mode',
  audioProbeStart: 'mode',
  awaitAlert: 'mode',
  bootTargetHeadless: 'mode',
  captureSnapshotWithCustomActions: 'mode',
  clearRuntimeHints: 'mode',
  configureProviderPortReverse: 'mode',
  deployApp: 'mode',
  deployMaterializedApp: 'mode',
  dismissAlert: 'mode',
  fillRef: 'mode',
  findText: 'mode',
  gestureViewport: 'mode',
  hoverPoint: 'mode',
  hoverRef: 'mode',
  keyboardDismiss: 'mode',
  keyboardEnter: 'mode',
  keyboardStatus: 'mode',
  listApps: 'mode',
  materializeAppSource: 'mode',
  mediaFastForward: 'mode',
  mediaNext: 'mode',
  mediaPlayPause: 'mode',
  mediaPrevious: 'mode',
  mediaRewind: 'mode',
  mute: 'mode',
  networkDump: 'mode',
  perfFrames: 'mode',
  perfMemorySample: 'mode',
  perfMemorySnapshot: 'mode',
  perfNativeCaptureCleanup: 'mode',
  perfNativeCaptureReattach: 'mode',
  perfNativeCaptureStart: 'mode',
  perfProfileReport: 'mode',
  performDirectionalFlingPlan: 'mode',
  performGesturePlan: 'mode',
  performMultiTouchGesturePlan: 'mode',
  performTargetAuthoredDrag: 'mode',
  power: 'mode',
  prepareAppleRunner: 'mode',
  querySelector: 'mode',
  readAlert: 'mode',
  readClipboard: 'mode',
  readSetting: 'mode',
  readTextAtPoint: 'mode',
  screenRecordingCleanup: 'mode',
  screenRecordingReattach: 'mode',
  screenRecordingStart: 'mode',
  sendPushNotification: 'mode',
  sendTelephonyEvent: 'mode',
  setFoldPose: 'mode',
  setOrientation: 'mode',
  setSetting: 'mode',
  setViewport: 'mode',
  shutdownTarget: 'mode',
  sleep: 'mode',
  tapElementSelector: 'mode',
  tapRef: 'mode',
  triggerAppEvent: 'mode',
  // The command itself only runs on an Android TV target, which Revyl does not rent.
  tvRemote: 'kind',
  typeText: 'mode',
  uninstallApp: 'mode',
  unlockOrientation: 'mode',
  volumeDown: 'mode',
  volumeUp: 'mode',
  wake: 'mode',
  writeClipboard: 'mode',
} as const satisfies Readonly<Record<RevylOperation, 'available' | 'mode' | 'kind'>>;

/** The typed reason one verdict of the matrix carries. */
const REFUSAL_REASONS = { mode: 'unsupported-provider-mode', kind: 'unsupported-device-kind' };

test('every operation cell reports the verdict its matrix row promises', () => {
  const operations = revylFacts(IOS_DEVICE).operations;
  // Nothing the facts report may be missing from the matrix, or the reverse.
  assert.deepEqual(
    Object.keys(operations).sort(),
    (Object.keys(EXPECTED_CELLS) as RevylOperation[]).sort(),
    'the facts and the matrix must cover the same operations',
  );
  for (const [cell, expected] of Object.entries(EXPECTED_CELLS) as [
    RevylOperation,
    'available' | 'mode' | 'kind',
  ][]) {
    const fact = operations[cell];
    if (expected === 'available') {
      assert.deepEqual(fact, { available: true }, cell);
      continue;
    }
    assert.equal(fact.available, false, cell);
    assert.equal(fact.reason, REFUSAL_REASONS[expected], cell);
  }
});

test('the refused text-entry and system-button cells name the substitute a caller can run', () => {
  const operations = revylFacts(IOS_DEVICE).operations;
  const typeText = operations.typeText;
  const appSwitcher = operations.appSwitcher;
  assert.ok(typeText && !typeText.available);
  assert.ok(appSwitcher && !appSwitcher.available);
  assert.match(typeText.hint ?? '', /fill/);
  assert.match(appSwitcher.hint ?? '', /home/);
});

test('the facts report the canonical device shape beside the provider mode', () => {
  assert.deepEqual(revylFacts(IOS_DEVICE).device, {
    family: 'apple',
    appleOs: 'ios',
    kind: 'simulator',
    target: 'mobile',
    providerMode: 'provider-runtime',
  });
});

test('a device this runtime does not own refuses the open and close targets', () => {
  const foreign: DeviceInfo = { ...IOS_DEVICE, id: 'other:ios:lease-1' };
  const facts = revylLifecycleFacts(foreign, true);
  assert.equal(facts.resolveOpenTarget?.available, false);
  assert.equal(facts.openApplication?.available, false);
  assert.equal(facts.closeApplication?.available, false);
  assert.equal(facts.finalizeApplicationClose?.available, false);
  // Every cell names the rule that decided it: a device outside the Revyl id space is not a target
  // this runtime can open or close an app on, however live its own session is. The reason is asserted
  // per cell so a wrong refusal category cannot pass here.
  for (const cell of [
    'resolveOpenTarget',
    'prepareApplicationOpen',
    'openApplication',
    'closeApplication',
    'finalizeApplicationClose',
  ] as const) {
    const fact = facts[cell];
    assert.ok(fact && !fact.available, cell);
    assert.equal(fact.reason, 'unsupported-provider-mode', cell);
  }
});

test('a session that has ended refuses the application-lifecycle targets', () => {
  const facts = revylLifecycleFacts(IOS_DEVICE, false);
  assert.equal(facts.resolveOpenTarget, liveSessionUnavailable);
  assert.equal(facts.closeApplication, liveSessionUnavailable);
  assert.equal(facts.openApplication, liveSessionUnavailable);
});

test('Revyl never offers port reverse or runtime hints to a rented device', () => {
  const live = revylLifecycleFacts(IOS_DEVICE, true);
  assert.equal(live.configureProviderPortReverse?.available, false);
  assert.equal(live.applyRuntimeHints?.available, false);
  assert.equal(live.prepareAppleRunner?.available, false);
});
