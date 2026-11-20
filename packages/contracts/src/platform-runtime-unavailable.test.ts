import assert from 'node:assert/strict';
import { test } from 'vitest';
import { localRuntimeOwner, providerRuntimeOwner } from './platform-runtime.ts';
import { applicationLifecycleOperationFacts } from './application-lifecycle-runtime.ts';
import { alertRuntimeOperationFacts } from './alert-runtime.ts';
import { appEventRuntimeOperationFacts } from './app-event-runtime.ts';
import { audioProbeRuntimeOperationFacts } from './audio-probe-runtime.ts';
import { backRuntimeOperationFacts } from './back-runtime.ts';
import { clipboardRuntimeOperationFacts } from './clipboard-runtime.ts';
import { elementTextRuntimeOperationFacts } from './element-text-runtime.ts';
import { focusRuntimeOperationFacts } from './focus-runtime.ts';
import { gestureRuntimeOperationFacts } from './gesture-runtime.ts';
import { keyboardRuntimeOperationFacts } from './keyboard-runtime.ts';
import { orientationRuntimeOperationFacts } from './orientation-runtime.ts';
import { perfRuntimeOperationFacts } from './perf-runtime.ts';
import { screenshotRuntimeOperationFacts } from './screenshot-runtime.ts';
import { scrollRuntimeOperationFacts } from './scroll-runtime.ts';
import { selectorObservationRuntimeOperationFacts } from './selector-observation-runtime.ts';
import { snapshotRuntimeOperationFacts } from './snapshot-runtime.ts';
import { systemButtonRuntimeOperationFacts } from './system-button-runtime.ts';
import { HOVER_UNAVAILABLE_HINT, touchRuntimeOperationFacts } from './touch-runtime.ts';
import { tvRemoteRuntimeOperationFacts } from './tv-remote-runtime.ts';
import { typeTextRuntimeOperationFacts } from './type-text-runtime.ts';
import { viewportRuntimeOperationFacts } from './viewport-runtime.ts';
import {
  createUnavailablePlatformRuntimeBinding,
  createUnavailablePlatformRuntimeFacts,
  type UnavailablePlatformRuntimeFacts,
} from './platform-runtime-unavailable.ts';

const device = {
  id: 'linux-host',
  name: 'Linux host',
  platform: 'linux',
  kind: 'device',
  state: 'booted',
} as const;

const lifecycle = applicationLifecycleOperationFacts({
  resolveOpenTarget: { available: false, reason: 'unsupported-platform-leaf' },
  prepareApplicationOpen: { available: false, reason: 'unsupported-platform-leaf' },
  openApplication: { available: false, reason: 'unsupported-platform-leaf' },
  applyRuntimeHints: { available: false, reason: 'unsupported-platform-leaf' },
  clearRuntimeHints: { available: false, reason: 'unsupported-platform-leaf' },
  closeApplication: { available: false, reason: 'unsupported-platform-leaf' },
  finalizeApplicationClose: { available: false, reason: 'unsupported-platform-leaf' },
  prepareAppleRunner: { available: false, reason: 'unsupported-platform-leaf' },
  configureProviderPortReverse: { available: false, reason: 'unsupported-platform-leaf' },
});

const UNAVAILABLE_FACTS: UnavailablePlatformRuntimeFacts = {
  appLog: { available: false, reason: 'unsupported-provider-mode' },
  network: { available: false, reason: 'owner-capability-missing' },
  screenshot: { available: false, reason: 'unsupported-device-kind' },
  viewport: { available: false, reason: 'unsupported-platform-leaf' },
  focus: { available: false, reason: 'unsupported-provider-mode' },
  gesture: { available: false, reason: 'unsupported-provider-mode' },
  scroll: { available: false, reason: 'unsupported-provider-mode' },
  typeText: { available: false, reason: 'unsupported-provider-mode' },
  touch: { available: false, reason: 'unsupported-provider-mode' },
  elementText: { available: false, reason: 'unsupported-provider-mode' },
  back: { available: false, reason: 'unsupported-provider-mode' },
  orientation: { available: false, reason: 'unsupported-provider-mode' },
  tvRemote: { available: false, reason: 'unsupported-provider-mode' },
  keyboard: { available: false, reason: 'unsupported-provider-mode' },
  clipboard: { available: false, reason: 'unsupported-provider-mode' },
  systemButton: { available: false, reason: 'unsupported-provider-mode' },
  fold: { available: false, reason: 'unsupported-provider-mode' },
  telephony: { available: false, reason: 'unsupported-provider-mode' },
  triggerAppEvent: { available: false, reason: 'unsupported-provider-mode' },
  settings: { available: false, reason: 'unsupported-provider-mode' },
  readAlert: { available: false, reason: 'unsupported-provider-mode' },
  awaitAlert: { available: false, reason: 'unsupported-provider-mode' },
  acceptAlert: { available: false, reason: 'unsupported-provider-mode' },
  dismissAlert: { available: false, reason: 'unsupported-provider-mode' },
  audioProbeCapture: { available: false, reason: 'unsupported-provider-mode' },
  audioProbeQuery: { available: false, reason: 'unsupported-provider-mode' },
  lifecycle,
};

test('generic unavailable binding preserves exact provider ownership and mode', async () => {
  const owner = providerRuntimeOwner('webdriver', 'tenant-a');
  const binding = createUnavailablePlatformRuntimeBinding(device, owner, UNAVAILABLE_FACTS);

  assert.equal(binding.owner, owner);
  assert.equal(binding.facts.device.providerMode, 'provider-runtime');
  assert.deepEqual(binding.facts.operations.setViewport, {
    available: false,
    reason: 'unsupported-platform-leaf',
  });
  // Interaction is owner-stated too: it never inherits the transport gap's reason.
  assert.deepEqual(binding.facts.operations.focusPoint, {
    available: false,
    reason: 'unsupported-provider-mode',
  });
  assert.deepEqual(binding.facts.operations.typeText, {
    available: false,
    reason: 'unsupported-provider-mode',
  });
  // Both capture cells are owner-stated, so neither inherits the network gap's reason.
  assert.deepEqual(binding.facts.operations.captureScreenshot, {
    available: false,
    reason: 'unsupported-device-kind',
  });
  assert.deepEqual(binding.facts.operations.readTextAtPoint, {
    available: false,
    reason: 'unsupported-provider-mode',
  });
  for (const operation of ['keyboardStatus', 'keyboardDismiss', 'keyboardEnter'] as const) {
    assert.deepEqual(binding.facts.operations[operation], {
      available: false,
      reason: 'unsupported-provider-mode',
    });
  }
  for (const operation of ['readClipboard', 'writeClipboard'] as const) {
    assert.deepEqual(binding.facts.operations[operation], {
      available: false,
      reason: 'unsupported-provider-mode',
    });
  }
  // `apps` is left unclassified above (an optional cell): it inherits the network gap's reason.
  assert.deepEqual(binding.facts.operations.listApps, {
    available: false,
    reason: 'owner-capability-missing',
  });
  assert.deepEqual(binding.operations, {});
  await binding[Symbol.asyncDispose]();
});

test('generic unavailable facts report provider mode local for a local family owner', () => {
  const owner = localRuntimeOwner('linux');
  assert.equal(
    createUnavailablePlatformRuntimeFacts(device, owner, UNAVAILABLE_FACTS).device.providerMode,
    'local',
  );
  assert.equal(
    createUnavailablePlatformRuntimeBinding(device, owner, UNAVAILABLE_FACTS).owner,
    owner,
  );
});

test('a refused touch cell answers both hover legs with the longpress redirection', () => {
  const { operations } = createUnavailablePlatformRuntimeFacts(
    device,
    localRuntimeOwner('linux'),
    UNAVAILABLE_FACTS,
  );
  assert.equal(UNAVAILABLE_FACTS.touch.hint, undefined);
  for (const hover of [operations.hoverPoint, operations.hoverRef]) {
    assert.deepEqual(hover, { ...UNAVAILABLE_FACTS.touch, hint: HOVER_UNAVAILABLE_HINT });
  }
});

test('the operations stated by name equal what each family facts builder produces', () => {
  // One distinguishable cell per family, so a key wired to the wrong family fails.
  const cell = (family: string) =>
    ({ available: false, reason: 'unsupported-provider-mode', hint: family }) as const;
  const facts = {
    ...Object.fromEntries(
      Object.keys(UNAVAILABLE_FACTS)
        .filter((family) => family !== 'lifecycle')
        .concat(['snapshot', 'perf'])
        .map((family) => [family, cell(family)]),
    ),
    lifecycle,
  } as unknown as UnavailablePlatformRuntimeFacts;
  const { operations } = createUnavailablePlatformRuntimeFacts(
    device,
    localRuntimeOwner('linux'),
    facts,
  );
  const fromBuilders = {
    ...screenshotRuntimeOperationFacts({ capture: cell('screenshot') }),
    ...snapshotRuntimeOperationFacts({
      capture: cell('snapshot'),
      customActions: cell('snapshot'),
      withoutActiveApp: cell('snapshot'),
    }),
    ...selectorObservationRuntimeOperationFacts({
      findText: cell('snapshot'),
      querySelector: cell('snapshot'),
    }),
    ...viewportRuntimeOperationFacts({ setViewport: cell('viewport') }),
    ...focusRuntimeOperationFacts({ focus: cell('focus') }),
    ...gestureRuntimeOperationFacts({ unsupported: cell('gesture') }),
    ...scrollRuntimeOperationFacts({ scroll: cell('scroll') }),
    ...typeTextRuntimeOperationFacts({ type: cell('typeText') }),
    ...touchRuntimeOperationFacts({
      unsupported: cell('touch'),
      tap: cell('touch'),
      longPress: cell('touch'),
      fill: cell('touch'),
    }),
    ...elementTextRuntimeOperationFacts({ readTextAtPoint: cell('elementText') }),
    ...backRuntimeOperationFacts({ back: cell('back') }),
    ...orientationRuntimeOperationFacts({
      orientation: cell('orientation'),
      unlock: cell('orientation'),
    }),
    ...tvRemoteRuntimeOperationFacts({ tvRemote: cell('tvRemote') }),
    ...keyboardRuntimeOperationFacts({ unsupported: cell('keyboard') }),
    ...clipboardRuntimeOperationFacts({ unsupported: cell('clipboard') }),
    ...systemButtonRuntimeOperationFacts({ unsupported: cell('systemButton') }),
    ...appEventRuntimeOperationFacts({ triggerAppEvent: cell('triggerAppEvent') }),
    ...alertRuntimeOperationFacts({
      read: cell('readAlert'),
      wait: cell('awaitAlert'),
      accept: cell('acceptAlert'),
      dismiss: cell('dismissAlert'),
    }),
    ...audioProbeRuntimeOperationFacts({
      capture: cell('audioProbeCapture'),
      query: cell('audioProbeQuery'),
    }),
    ...perfRuntimeOperationFacts({
      frames: cell('perf'),
      memorySample: cell('perf'),
      memorySnapshot: cell('perf'),
      nativeCapture: cell('perf'),
      profileReport: cell('perf'),
    }),
  };
  const stated = Object.fromEntries(
    Object.keys(fromBuilders).map((key) => [key, operations[key as keyof typeof operations]]),
  );
  assert.deepEqual(stated, fromBuilders);
});
