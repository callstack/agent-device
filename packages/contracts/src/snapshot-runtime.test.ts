import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  Interactor,
  RunnerContext,
  SnapshotRuntimeAcquiredResult,
  SnapshotResult,
} from './interactor-types.ts';
import {
  bindLocalSnapshotInteractor,
  bindProviderSnapshotInteractor,
  captureSnapshotSignal,
} from './snapshot-runtime.ts';

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

test('provider snapshot binding presents acquired facts through the supplied host owner', async () => {
  const acquired: SnapshotRuntimeAcquiredResult = {
    stage: 'acquired',
    acquisition: {
      producer: 'appium-source',
      intent: 'full',
      nodes: [],
      viewport: { kind: 'reported', rect: { x: 0, y: 0, width: 390, height: 844 } },
      lineage: { targetId: 'ios-1' },
      residue: [{ kind: 'unavailable-fact', fact: 'truncation' }],
    },
  };
  const presented: SnapshotResult = {
    backend: 'xctest',
    producer: 'appium-source',
    nodes: [],
  };
  let presentedInput: SnapshotRuntimeAcquiredResult | undefined;
  const operations = bindProviderSnapshotInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => ({ snapshot: async () => acquired }) as unknown as Interactor,
    presentIosAcquisition: async (input) => {
      presentedInput = input;
      return presented;
    },
  });

  const result = await operations.captureSnapshot({ options: { raw: true } });
  assert.equal(result, presented);
  assert.equal(presentedInput, acquired);
});

// ---------------------------------------------------------------------------
// Per-capture cancellation (`CaptureSnapshotInput.signal`). A `DeviceBinding`'s
// signal is fixed at bind time, but `wait` binds once and polls many times, so
// each poll must be able to cancel its own capture without cancelling the
// binding. These are the contract-level halves of that claim; the poll-deadline
// behaviour itself is proven end to end in `src/daemon/__tests__/wait-runtime.test.ts`.
// ---------------------------------------------------------------------------

test('a capture with no per-capture signal receives the binding signal itself, not a wrapper', () => {
  const binding = new AbortController().signal;

  // Identity, deliberately: a wrapper would satisfy a deep-equal while quietly changing
  // cancellation semantics for every single-capture consumer (`snapshot`, `diff`), which pass
  // no signal at all.
  assert.equal(captureSnapshotSignal(binding, {}), binding);
  assert.equal(captureSnapshotSignal(binding, { options: { appBundleId: 'x' } }), binding);
});

test('binding-level cancellation still aborts a capture that carries its own signal', () => {
  const binding = new AbortController();
  const perCapture = new AbortController();

  const composed = captureSnapshotSignal(binding.signal, { signal: perCapture.signal });

  assert.equal(composed.aborted, false);
  binding.abort();
  // The composition adds a second way to cancel; it must not have replaced the first.
  assert.equal(composed.aborted, true);
});

test('a per-capture signal aborts its own capture without aborting the binding', () => {
  const binding = new AbortController();
  const perCapture = new AbortController();

  const composed = captureSnapshotSignal(binding.signal, { signal: perCapture.signal });
  perCapture.abort(new DOMException('Wait deadline exceeded', 'TimeoutError'));

  assert.equal(composed.aborted, true);
  // The binding outlives the poll: the next poll of the same wait still has a live binding.
  assert.equal(binding.signal.aborted, false);
});

test('the shared interactor binding composes the per-capture signal it is handed', async () => {
  const binding = new AbortController();
  const perCapture = new AbortController();
  let capturedSignal: AbortSignal | undefined;
  const operations = bindLocalSnapshotInteractor({
    device,
    signal: binding.signal,
    resolveInteractor: async () =>
      ({
        snapshot: async (options: Parameters<Interactor['snapshot']>[0]) => {
          capturedSignal = options?.signal;
          return { backend: 'android', nodes: [] };
        },
      }) as unknown as Interactor,
  });

  await operations.captureSnapshot({ signal: perCapture.signal });

  assert.ok(capturedSignal, 'the interactor must receive a signal');
  assert.equal(capturedSignal.aborted, false);
  perCapture.abort(new DOMException('Wait deadline exceeded', 'TimeoutError'));
  assert.equal(capturedSignal.aborted, true, 'the poll deadline must reach the platform');
});
