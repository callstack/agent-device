import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor, RunnerContext } from './interactor-types.ts';
import { bindLocalSnapshotInteractor, bindProviderSnapshotInteractor } from './snapshot-runtime.ts';

const device: DeviceInfo = {
  id: 'snapshot-device',
  name: 'Snapshot Device',
  platform: 'android',
  kind: 'emulator',
  target: 'mobile',
};

test('local snapshot binding injects its signal and resolves only its selected device', async () => {
  const controller = new AbortController();
  let resolvedDevice: DeviceInfo | undefined;
  let resolvedRunner: RunnerContext | undefined;
  let capturedOptions: Parameters<Interactor['snapshot']>[0];
  const operations = bindLocalSnapshotInteractor({
    device,
    signal: controller.signal,
    resolveInteractor: async (selectedDevice, runner) => {
      resolvedDevice = selectedDevice;
      resolvedRunner = runner;
      return {
        snapshot: async (options: Parameters<Interactor['snapshot']>[0]) => {
          capturedOptions = options;
          return { backend: 'android', nodes: [] };
        },
      } as unknown as Interactor;
    },
  });

  assert.equal(resolvedDevice, undefined, 'binding must not eagerly construct the interactor');

  await operations.captureSnapshot({
    options: {
      appBundleId: 'com.example.app',
      interactiveOnly: true,
      preferredBackend: 'private-ax',
    },
    execution: { requestId: 'request-1', verbose: true },
  });

  assert.equal(resolvedDevice, device);
  assert.equal(resolvedRunner?.requestId, 'request-1');
  assert.equal(resolvedRunner?.appBundleId, 'com.example.app');
  assert.equal(resolvedRunner?.signal, controller.signal);
  assert.equal(capturedOptions?.interactiveOnly, true);
  assert.equal(capturedOptions?.preferredBackend, 'private-ax');
  assert.equal(capturedOptions?.signal, controller.signal);
});

test('provider snapshot binding fails closed when its selected owner loses the interactor', async () => {
  const operations = bindProviderSnapshotInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => undefined,
  });

  await assert.rejects(
    operations.captureSnapshot({}),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Provider-owned snapshot operation has no bound provider interactor.',
  );
});
