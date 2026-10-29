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

/** The cells a live session reports as available: what Revyl's device-proxy actions carry. */
const AVAILABLE_CELLS = [
  'captureSnapshot',
  'captureSnapshotWithoutActiveApp',
  'captureScreenshot',
  'tapPoint',
  'longPressPoint',
  'fillPoint',
  'focusPoint',
  'scrollDirection',
  'back',
  'home',
  'openApplication',
  'closeApplication',
] as const satisfies readonly (keyof ReturnType<typeof revylFacts>['operations'])[];

/** The cells Revyl's worker has no action for, so its facts refuse them. */
const REFUSED_CELLS = [
  // The ref- and selector-addressed legs need an interactor member Revyl's worker has no action for.
  'tapRef',
  'fillRef',
  'tapElementSelector',
  'typeText',
  'keyboardStatus',
  'keyboardDismiss',
  'keyboardEnter',
  'readClipboard',
  'writeClipboard',
  'setOrientation',
  'performGesturePlan',
  'screenRecordingStart',
  'appLogInspect',
  'networkDump',
  'listApps',
  'deployApp',
  'sendPushNotification',
  'appState',
  'setFoldPose',
  'sendTelephonyEvent',
  'tvRemote',
  'readAlert',
  'setViewport',
  'readTextAtPoint',
] as const satisfies readonly (keyof ReturnType<typeof revylFacts>['operations'])[];

test('a live session admits the device-proxy actions and refuses what no worker action carries', () => {
  const operations = revylFacts(IOS_DEVICE).operations;
  for (const cell of AVAILABLE_CELLS) {
    assert.deepEqual(operations[cell], { available: true }, cell);
  }
  for (const cell of REFUSED_CELLS) {
    assert.equal(operations[cell].available, false, cell);
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
  assert.equal(revylLifecycleFacts(foreign, true).resolveOpenTarget?.available, false);
  assert.equal(revylLifecycleFacts(IOS_DEVICE, false).resolveOpenTarget, liveSessionUnavailable);
  assert.equal(revylLifecycleFacts(IOS_DEVICE, false).closeApplication, liveSessionUnavailable);
});

test('Revyl never offers port reverse or runtime hints to a rented device', () => {
  const live = revylLifecycleFacts(IOS_DEVICE, true);
  assert.equal(live.configureProviderPortReverse?.available, false);
  assert.equal(live.applyRuntimeHints?.available, false);
  assert.equal(live.prepareAppleRunner?.available, false);
});
