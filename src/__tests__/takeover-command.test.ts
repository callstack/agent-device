import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { AgentDeviceClient } from '../agent-device-client.ts';
import {
  renderTakeoverStarted,
  renderTakeoverStatus,
  takeoverCommand,
} from '../cli/commands/takeover.ts';
import type { HumanControlHold } from '../daemon/human-control-contract.ts';

const mocks = vi.hoisted(() => ({
  sendRequest: vi.fn(),
  writeCommandOutput: vi.fn(),
}));

vi.mock('../daemon/client/daemon-client-lifecycle.ts', () => ({
  ensureDaemon: async () => ({ info: { port: 1234, token: 'daemon-token' } }),
  resolveClientSettings: () => ({ paths: { socketPath: '/tmp/daemon.sock' } }),
}));

vi.mock('../daemon/client/daemon-client-transport.ts', () => ({
  sendRequest: mocks.sendRequest,
}));

vi.mock('../cli/commands/shared.ts', () => ({
  writeCommandOutput: mocks.writeCommandOutput,
}));

const HOLD: HumanControlHold = {
  id: 'takeover-1',
  scope: { deviceKey: 'sim-1', deviceName: 'iPhone 17 Pro', platform: 'ios' },
  reason: 'Human is interacting with the simulator.',
  createdAt: 1_000,
  updatedAt: 1_000,
  expiresAt: 16_000,
};

beforeEach(() => {
  mocks.sendRequest.mockReset();
  mocks.writeCommandOutput.mockReset();
});

test('takeover output explains the active hold and release gesture', () => {
  assert.equal(
    renderTakeoverStarted(HOLD),
    [
      'Human control active for iPhone 17 Pro (sim-1).',
      'Agent interactions are paused. Press Ctrl+C to return control.',
      'Hold: takeover-1',
    ].join('\n'),
  );
  assert.equal(renderTakeoverStatus([]), 'No active human-control holds.');
  assert.match(renderTakeoverStatus([HOLD]), /takeover-1: iPhone 17 Pro \(sim-1\)/);
});

test('takeover status lists holds through the local daemon command', async () => {
  mocks.sendRequest.mockResolvedValue({ ok: true, data: { holds: [HOLD] } });

  assert.equal(await runTakeover(['status']), true);
  assert.deepEqual(mocks.sendRequest.mock.calls[0]?.[1].positionals, ['list']);
  assert.deepEqual(mocks.writeCommandOutput.mock.calls[0]?.[1], { holds: [HOLD] });
});

test('takeover release removes the named hold through the local daemon command', async () => {
  mocks.sendRequest.mockResolvedValue({ ok: true, data: { released: true } });

  assert.equal(await runTakeover(['release', 'takeover-1']), true);
  assert.deepEqual(mocks.sendRequest.mock.calls[0]?.[1].positionals, ['remove', 'takeover-1']);
  assert.deepEqual(mocks.writeCommandOutput.mock.calls[0]?.[1], {
    holdId: 'takeover-1',
    released: true,
  });
});

test('takeover rejects malformed actions before contacting the daemon', async () => {
  await assert.rejects(runTakeover(['status', 'extra']), /does not accept additional arguments/);
  await assert.rejects(runTakeover(['release']), /requires a hold id/);
  await assert.rejects(runTakeover(['unknown']), /accepts only/);
  assert.equal(mocks.sendRequest.mock.calls.length, 0);
});

async function runTakeover(positionals: string[]): Promise<boolean> {
  return await takeoverCommand({
    positionals,
    flags: { json: false, help: false, version: false },
    client: {} as AgentDeviceClient,
  });
}
