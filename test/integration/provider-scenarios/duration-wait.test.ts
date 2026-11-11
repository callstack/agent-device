import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { skipWhenLoopbackUnavailable } from '@agent-device/test-kit';
import { createProviderScenarioHarness } from './harness.ts';
import { assertRpcOk } from './assertions.ts';

const AMBIGUOUS_DEVICES: DeviceInfo[] = ['first', 'second'].map((id) => ({
  id,
  name: id,
  platform: 'android',
  kind: 'device',
  booted: true,
}));

for (const [label, devices] of [
  ['empty', []],
  ['ambiguous', AMBIGUOUS_DEVICES],
] as const) {
  test(`duration wait needs no ${label} inventory selection`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t, 'device-free duration wait')) return;
    const inventory = vi.fn(async () => [...devices]);
    const daemon = await createProviderScenarioHarness({ deviceInventoryProvider: inventory });
    try {
      const initialReads = inventory.mock.calls.length;
      assert.deepEqual(assertRpcOk(await daemon.callCommand('wait', ['5'])), { waitedMs: 5 });
      assert.equal(inventory.mock.calls.length, initialReads);
    } finally {
      await daemon.close();
    }
  });
}

test('observing waits still select a device and explicit missing sessions stay refused', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'duration and observing wait admission')) return;
  const inventory = vi.fn(async () => []);
  const daemon = await createProviderScenarioHarness({ deviceInventoryProvider: inventory });
  try {
    const beforeObserving = inventory.mock.calls.length;
    const observed = await daemon.callCommand('wait', ['label="Ready"']);
    assert.equal(observed.json.error?.data?.code, 'DEVICE_NOT_FOUND');
    assert.ok(inventory.mock.calls.length > beforeObserving);
    const beforeNamed = inventory.mock.calls.length;
    const named = await daemon.callCommand(
      'wait',
      ['5'],
      {},
      {
        session: 'missing',
        meta: { sessionExplicit: true },
      },
    );
    assert.equal(named.json.error?.data?.code, 'SESSION_NOT_FOUND');
    assert.equal(inventory.mock.calls.length, beforeNamed);
  } finally {
    await daemon.close();
  }
});
