import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import {
  renderTakeoverStarted,
  renderTakeoverStatus,
  takeoverCommand,
} from '../cli/commands/takeover.ts';
import {
  HUMAN_CONTROL_HOLD,
  createControlLatch,
} from '../daemon/__tests__/human-control-fixtures.ts';
import type { DaemonRequest } from '@agent-device/kernel/contracts';
import { TAKEOVER_CLI_FLAGS } from './test-utils/client-lease-fixtures.ts';

const mocks = vi.hoisted(() => ({ writeCommandOutput: vi.fn() }));
vi.mock('../cli/commands/shared.ts', () => ({ writeCommandOutput: mocks.writeCommandOutput }));
beforeEach(() => mocks.writeCommandOutput.mockReset());
afterEach(() => vi.useRealTimers());

function clientForTest() {
  const transport = vi.fn(async (req: Omit<DaemonRequest, 'token'>) => ({
    ok: true as const,
    data:
      req.positionals?.[0] === 'list'
        ? { holds: [HUMAN_CONTROL_HOLD] }
        : req.positionals?.[0] === 'remove'
          ? { released: true }
          : { hold: { ...HUMAN_CONTROL_HOLD, id: req.positionals?.[1] } },
  }));
  const client = createAgentDeviceClient(
    { session: 'remote-session', leaseId: 'lease-1', tenant: 'tenant-a', runId: 'run-a' },
    { transport },
  );
  return { client, transport };
}

test('takeover output explains the hold and release gesture', () => {
  assert.match(
    renderTakeoverStarted(HUMAN_CONTROL_HOLD),
    /Human control active for ios:mobile:sim-1/,
  );
  assert.match(renderTakeoverStarted(HUMAN_CONTROL_HOLD), /Press Ctrl\+C/);
  assert.equal(renderTakeoverStatus([]), 'No active human-control holds.');
  assert.match(renderTakeoverStatus([HUMAN_CONTROL_HOLD]), /operator-1: ios:mobile:sim-1/);
});

test('takeover status and release use the configured lease client', async () => {
  const { client, transport } = clientForTest();
  await takeoverCommand({ client, flags: TAKEOVER_CLI_FLAGS, positionals: ['status'] });
  await takeoverCommand({
    client,
    flags: TAKEOVER_CLI_FLAGS,
    positionals: ['release', 'operator-1'],
  });
  assert.deepEqual(
    transport.mock.calls.map(([req]) => req.positionals),
    [['list'], ['remove', 'operator-1']],
  );
  for (const [req] of transport.mock.calls) {
    assert.equal(req.command, 'human_control');
    assert.equal(req.session, 'remote-session');
    assert.equal(req.meta?.leaseId, 'lease-1');
  }
});

test('takeover rejects malformed actions without contacting the daemon', async () => {
  const { client, transport } = clientForTest();
  for (const positionals of [['release'], ['status', 'extra'], ['unknown']]) {
    await assert.rejects(takeoverCommand({ client, flags: TAKEOVER_CLI_FLAGS, positionals }), {
      code: 'INVALID_ARGS',
    });
  }
  assert.equal(transport.mock.calls.length, 0);
});

test('foreground takeover renews its admitted lease hold and releases it on Ctrl+C', async () => {
  vi.useFakeTimers();
  const { client, transport } = clientForTest();
  const started = createControlLatch();
  mocks.writeCommandOutput.mockImplementationOnce(() => started.resolve());
  const pending = takeoverCommand({ client, flags: TAKEOVER_CLI_FLAGS, positionals: [] });
  await started.promise;
  await vi.advanceTimersByTimeAsync(5_000);
  process.emit('SIGINT');
  assert.equal(await pending, true);
  assert.deepEqual(
    transport.mock.calls.map(([req]) => req.positionals?.[0]),
    ['put', 'put', 'remove'],
  );
  assert.equal(
    transport.mock.calls[0]?.[0].positionals?.[1],
    transport.mock.calls[2]?.[0].positionals?.[1],
  );
  const input = JSON.parse(transport.mock.calls[0]?.[0].positionals?.[2] ?? '{}') as Record<
    string,
    unknown
  >;
  assert.equal(input.ttlMs, 15_000);
  assert.equal(input.scope, undefined);
});

test('a failed heartbeat stops foreground takeover and attempts release', async () => {
  vi.useFakeTimers();
  const { client, transport } = clientForTest();
  const started = createControlLatch();
  mocks.writeCommandOutput.mockImplementationOnce(() => started.resolve());
  const pending = takeoverCommand({ client, flags: TAKEOVER_CLI_FLAGS, positionals: [] });
  const rejected = assert.rejects(pending, /heartbeat failed/);
  await started.promise;
  transport.mockRejectedValueOnce(new Error('heartbeat failed'));
  await vi.advanceTimersByTimeAsync(5_000);
  await rejected;
  assert.equal(transport.mock.calls.at(-1)?.[0].positionals?.[0], 'remove');
});
