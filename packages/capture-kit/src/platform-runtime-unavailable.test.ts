import assert from 'node:assert/strict';
import { test } from 'vitest';
import { localRuntimeOwner, providerRuntimeOwner } from '@agent-device/contracts/platform';
import {
  createUnavailablePlatformRuntimeBinding,
  createUnavailablePlatformRuntimeOwner,
} from './platform-runtime-unavailable.ts';

const device = {
  id: 'linux-host',
  name: 'Linux host',
  platform: 'linux',
  kind: 'device',
  state: 'booted',
} as const;

const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

test('builds one complete combined unavailable owner without fake operations', async () => {
  const owner = createUnavailablePlatformRuntimeOwner('linux', {
    appLog: { available: false, reason: 'unsupported-platform-leaf' },
    network: { available: false, reason: 'owner-capability-missing' },
  });
  const binding = await owner.bind({ device, intent: { kind: 'ordinary' }, scope });

  assert.deepEqual(Object.keys(binding.facts.operations).sort(), [
    'appLogCleanup',
    'appLogDoctor',
    'appLogInspect',
    'appLogReattach',
    'appLogStart',
    'networkDump',
  ]);
  assert.deepEqual(binding.operations, {});
  await binding[Symbol.asyncDispose]();
});

test('rejects a planted wrong exact owner before producing a binding', async () => {
  const owner = createUnavailablePlatformRuntimeOwner('linux', {
    appLog: { available: false, reason: 'unsupported-platform-leaf' },
    network: { available: false, reason: 'unsupported-platform-leaf' },
  });
  await assert.rejects(
    owner.bind({
      device,
      intent: {
        kind: 'exact-owner',
        owner: localRuntimeOwner('vega'),
        fence: { token: 'token', generation: 1 },
      },
      scope,
    }),
    /identity does not match/,
  );
});

test('generic unavailable binding preserves exact provider ownership and mode', async () => {
  const owner = providerRuntimeOwner('webdriver', 'tenant-a');
  const binding = createUnavailablePlatformRuntimeBinding(device, owner, {
    appLog: { available: false, reason: 'unsupported-provider-mode' },
    network: { available: false, reason: 'owner-capability-missing' },
  });

  assert.equal(binding.owner, owner);
  assert.equal(binding.facts.device.providerMode, 'provider-runtime');
  assert.deepEqual(binding.operations, {});
  await binding[Symbol.asyncDispose]();
});
