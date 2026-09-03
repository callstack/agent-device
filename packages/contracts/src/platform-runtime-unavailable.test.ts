import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  localRuntimeOwner,
  managedLocalRuntimeOwner,
  providerRuntimeOwner,
} from './platform-runtime.ts';
import { applicationLifecycleOperationFacts } from './application-lifecycle-runtime.ts';
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
  home: { available: false, reason: 'unsupported-provider-mode' },
  orientation: { available: false, reason: 'unsupported-provider-mode' },
  tvRemote: { available: false, reason: 'unsupported-provider-mode' },
  keyboardStatus: { available: false, reason: 'unsupported-provider-mode' },
  keyboardDismiss: { available: false, reason: 'unsupported-provider-mode' },
  keyboardEnter: { available: false, reason: 'unsupported-provider-mode' },
  readClipboard: { available: false, reason: 'unsupported-provider-mode' },
  writeClipboard: { available: false, reason: 'unsupported-provider-mode' },
  appSwitcher: { available: false, reason: 'unsupported-provider-mode' },
  triggerAppEvent: { available: false, reason: 'unsupported-provider-mode' },
  setSetting: { available: false, reason: 'unsupported-provider-mode' },
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
  assert.deepEqual(binding.operations, {});
  await binding[Symbol.asyncDispose]();
});

test('generic unavailable facts report provider mode local for a managed local owner', () => {
  const owner = managedLocalRuntimeOwner('sim-a');
  assert.equal(
    createUnavailablePlatformRuntimeFacts(device, owner, UNAVAILABLE_FACTS).device.providerMode,
    'local',
  );
  assert.equal(
    createUnavailablePlatformRuntimeFacts(device, localRuntimeOwner('linux'), UNAVAILABLE_FACTS)
      .device.providerMode,
    'local',
  );
  assert.equal(
    createUnavailablePlatformRuntimeBinding(device, owner, UNAVAILABLE_FACTS).owner,
    owner,
  );
});
