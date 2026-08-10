import assert from 'node:assert/strict';
import { test } from 'vitest';
import { localRuntimeOwner, providerRuntimeOwner } from '@agent-device/contracts/platform';
import {
  createUnavailableAppLogBinding,
  createUnavailableAppLogRuntimeOwner,
} from './app-log-unavailable-runtime.ts';

const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

test('unavailable app-log owner binds only its exact family and publishes complete facts', async () => {
  const runtime = createUnavailableAppLogRuntimeOwner('vega', {
    available: false,
    reason: 'unsupported-platform-leaf',
    hint: 'No app-log transport.',
  });
  const device = { platform: 'vega', id: 'vega', name: 'Vega', kind: 'device' } as const;
  const binding = await runtime.bind({ device, intent: { kind: 'ordinary' }, scope });

  assert.equal(runtime.ownsDevice(device), true);
  assert.deepEqual(binding.owner, localRuntimeOwner('vega'));
  assert.deepEqual(Object.keys(binding.operations), []);
  assert.deepEqual(
    new Set(Object.values(binding.facts.operations)),
    new Set([
      { available: false, reason: 'unsupported-platform-leaf', hint: 'No app-log transport.' },
    ]),
  );
  await assert.doesNotReject(() =>
    runtime.bind({
      device,
      intent: {
        kind: 'exact-owner',
        owner: localRuntimeOwner('vega'),
        fence: { token: 'f', generation: 1 },
      },
      scope,
    }),
  );
  await assert.rejects(
    () =>
      runtime.bind({
        device,
        intent: {
          kind: 'exact-owner',
          owner: localRuntimeOwner('linux'),
          fence: { token: 'f', generation: 1 },
        },
        scope,
      }),
    /identity does not match/,
  );
  await assert.rejects(
    () =>
      runtime.bind({
        device: { ...device, platform: 'linux' },
        intent: { kind: 'ordinary' },
        scope,
      }),
    /cannot bind linux/,
  );
});

test('unavailable app-log binding derives provider facts without exposing operations', async () => {
  const device = { platform: 'android', id: 'remote', name: 'Remote', kind: 'emulator' } as const;
  const owner = providerRuntimeOwner('remote', 'default');
  const binding = createUnavailableAppLogBinding(device, owner, {
    available: false,
    reason: 'unsupported-provider-mode',
  });

  assert.equal(binding.facts.device.providerMode, 'provider-runtime');
  assert.deepEqual(binding.facts.operations.appLogStart, {
    available: false,
    reason: 'unsupported-provider-mode',
  });
  assert.deepEqual(binding.operations, {});
  await binding[Symbol.asyncDispose]();
});
