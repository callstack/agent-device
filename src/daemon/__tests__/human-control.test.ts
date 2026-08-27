import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { HumanControlRegistry } from '../human-control.ts';

test('human-control holds persist and expire by ttl', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-human-control-'));
  const statePath = path.join(root, 'human-control.json');
  let now = 1_000;

  try {
    const registry = new HumanControlRegistry({ statePath, now: () => now });
    const hold = registry.upsert('operator-1', {
      scope: { deviceKey: 'SIM-1', deviceName: 'iPhone 17 Pro', platform: 'ios' },
      reason: 'Manual inspection',
      ttlMs: 5_000,
    });

    assert.equal(hold.createdAt, 1_000);
    assert.equal(hold.expiresAt, 6_000);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);

    const restored = new HumanControlRegistry({ statePath, now: () => now });
    assert.deepEqual(restored.list(), [hold]);
    assert.equal(restored.isDeviceControlled('sim-1'), true);

    now = 6_000;
    assert.deepEqual(restored.list(), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).holds, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('human-control activation waits for an active mutation and blocks later mutations', async () => {
  const registry = new HumanControlRegistry();
  let finishMutation: (() => void) | undefined;
  let markMutationStarted: (() => void) | undefined;
  const mutationStarted = new Promise<void>((resolve) => {
    markMutationStarted = resolve;
  });
  const mutationFinished = new Promise<void>((resolve) => {
    finishMutation = resolve;
  });
  const mutation = registry.runDeviceMutation(['SIM-1', 'iPhone 17 Pro'], async () => {
    markMutationStarted?.();
    await mutationFinished;
  });
  await mutationStarted;

  registry.upsert('operator-1', {
    scope: { deviceKey: 'sim-1' },
    reason: 'Human is interacting with the simulator.',
  });
  let idle = false;
  const waitForIdle = registry.waitForDeviceIdle('sim-1').then(() => {
    idle = true;
  });
  await Promise.resolve();
  assert.equal(idle, false);

  finishMutation?.();
  await mutation;
  await waitForIdle;
  assert.equal(idle, true);

  await assert.rejects(
    registry.runDeviceMutation(['SIM-1'], async () => undefined),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVICE_IN_USE');
      assert.equal(
        (error as { details?: { reason?: string } }).details?.reason,
        'human_control_active',
      );
      assert.match((error as Error).message, /agent interactions are temporarily disabled/i);
      assert.equal((error as { details?: { holdId?: string } }).details?.holdId, 'operator-1');
      return true;
    },
  );
});
