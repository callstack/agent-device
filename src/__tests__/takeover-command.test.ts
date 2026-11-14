import { createTestHostEnvironment, HUMAN_CONTROL_HOLD } from '@agent-device/test-kit';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { createAgentDeviceClient } from '@agent-device/client';
import {
  renderTakeoverHold,
  renderTakeoverStarted,
  renderTakeoverStatus,
  takeoverCommand,
} from '../cli/commands/takeover.ts';
import type { DaemonRequest } from '@agent-device/kernel/contracts';
import { TAKEOVER_CLI_FLAGS } from './test-utils/client-lease-fixtures.ts';

const mocks = vi.hoisted(() => ({
  writeCommandOutput: vi.fn(),
  putHostHumanControlHold: vi.fn(),
  removeHostHumanControlHold: vi.fn(),
  resolveHostHoldAdmin: vi.fn(),
}));
vi.mock('../cli/commands/shared.ts', () => ({ writeCommandOutput: mocks.writeCommandOutput }));
vi.mock('../cli/commands/takeover-hold-admin.ts', () => ({
  putHostHumanControlHold: mocks.putHostHumanControlHold,
  removeHostHumanControlHold: mocks.removeHostHumanControlHold,
  resolveHostHoldAdmin: mocks.resolveHostHoldAdmin,
}));
beforeEach(() => {
  mocks.writeCommandOutput.mockReset();
  mocks.putHostHumanControlHold.mockReset();
  mocks.removeHostHumanControlHold.mockReset();
  mocks.resolveHostHoldAdmin.mockReset();
  mocks.resolveHostHoldAdmin.mockResolvedValue({
    baseUrl: 'http://127.0.0.1:4310',
    token: 'host-token',
  });
  mocks.putHostHumanControlHold.mockImplementation(async ({ holdId }) => ({
    ...HUMAN_CONTROL_HOLD,
    id: holdId,
  }));
  mocks.removeHostHumanControlHold.mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

function createControlLatch() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

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
  await takeoverCommand({
    host: createTestHostEnvironment(),
    client,
    flags: { ...TAKEOVER_CLI_FLAGS, session: 'remote-session' },
    positionals: ['status'],
  });
  await takeoverCommand({
    host: createTestHostEnvironment(),
    client,
    flags: { ...TAKEOVER_CLI_FLAGS, session: 'remote-session' },
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
    await assert.rejects(
      takeoverCommand({
        host: createTestHostEnvironment(),
        client,
        flags: TAKEOVER_CLI_FLAGS,
        positionals,
      }),
      {
        code: 'INVALID_ARGS',
      },
    );
  }
  assert.equal(transport.mock.calls.length, 0);
});

test('foreground takeover renews its admitted lease hold and releases it on Ctrl+C', async () => {
  vi.useFakeTimers();
  const { client, transport } = clientForTest();
  const started = createControlLatch();
  mocks.writeCommandOutput.mockImplementationOnce(() => started.resolve());
  const pending = takeoverCommand({
    host: createTestHostEnvironment(),
    client,
    flags: TAKEOVER_CLI_FLAGS,
    positionals: [],
  });
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
  const pending = takeoverCommand({
    host: createTestHostEnvironment(),
    client,
    flags: TAKEOVER_CLI_FLAGS,
    positionals: [],
  });
  const rejected = assert.rejects(pending, /heartbeat failed/);
  await started.promise;
  transport.mockRejectedValueOnce(new Error('heartbeat failed'));
  await vi.advanceTimersByTimeAsync(5_000);
  await rejected;
  assert.equal(transport.mock.calls.at(-1)?.[0].positionals?.[0], 'remove');
});

test('takeover hold pins the exact device key with the default TTL and reason', async () => {
  const { client } = clientForTest();
  await takeoverCommand({
    host: createTestHostEnvironment(),
    client,
    flags: { ...TAKEOVER_CLI_FLAGS, leaseBackend: 'ios-instance', deviceKey: 'ios:mobile:sim-1' },
    positionals: ['hold'],
  });
  assert.equal(mocks.putHostHumanControlHold.mock.calls.length, 1);
  const call = mocks.putHostHumanControlHold.mock.calls[0]?.[0] as Record<string, unknown>;
  assert.deepEqual(call.scope, { backend: 'ios-instance', deviceKey: 'ios:mobile:sim-1' });
  const input = call.input as Record<string, unknown>;
  assert.equal(input.ttlMs, 60_000);
  assert.equal(input.reason, 'A script outside agent-device is holding this device.');
  assert.match(String(call.holdId), /^takeover-/);
  assert.equal(mocks.resolveHostHoldAdmin.mock.calls.length, 1);
});

test('takeover hold names a custom reason and TTL', async () => {
  const { client } = clientForTest();
  await takeoverCommand({
    host: createTestHostEnvironment(),
    client,
    flags: {
      ...TAKEOVER_CLI_FLAGS,
      leaseBackend: 'android-instance',
      deviceKey: 'android:mobile:serial-1',
      reason: 'flashing the device',
      ttlMs: 60000,
    },
    positionals: ['hold'],
  });
  const call = mocks.putHostHumanControlHold.mock.calls[0]?.[0] as Record<string, unknown>;
  assert.equal((call.input as Record<string, unknown>).reason, 'flashing the device');
  assert.equal((call.input as Record<string, unknown>).ttlMs, 60000);
});

test('takeover hold derives the lease device key from one resolved device', async () => {
  const { client, transport } = clientForTest();
  const devices = vi.fn(async () => [
    {
      platform: 'android' as const,
      target: 'mobile' as const,
      kind: 'device' as const,
      id: 'serial-1',
      name: 'Pixel',
      identifiers: {},
    },
  ]);
  const holdClient = { ...client, devices: { ...client.devices, list: devices } };
  await takeoverCommand({
    host: createTestHostEnvironment(),
    client: holdClient,
    flags: { ...TAKEOVER_CLI_FLAGS, platform: 'android', serial: 'serial-1' },
    positionals: ['hold'],
  });
  const call = mocks.putHostHumanControlHold.mock.calls[0]?.[0] as Record<string, unknown>;
  assert.deepEqual(call.scope, {
    backend: 'android-instance',
    deviceKey: 'android:mobile:serial-1',
  });
  assert.equal(transport.mock.calls.length, 0);
});

test('takeover hold refuses two device answers, an unnamed backend, and ambiguous selectors', async () => {
  const { client } = clientForTest();
  const ambiguousClient = {
    ...client,
    devices: {
      ...client.devices,
      list: vi.fn(async () => [
        {
          platform: 'android' as const,
          target: 'mobile' as const,
          kind: 'device' as const,
          id: 'a',
          name: 'A',
          identifiers: {},
        },
        {
          platform: 'android' as const,
          target: 'mobile' as const,
          kind: 'device' as const,
          id: 'b',
          name: 'B',
          identifiers: {},
        },
      ]),
    },
  };
  const cases: Array<{
    flags: typeof TAKEOVER_CLI_FLAGS;
    client: typeof client;
    message: RegExp;
  }> = [
    {
      flags: { ...TAKEOVER_CLI_FLAGS, deviceKey: 'android:mobile:a', serial: 'serial-1' },
      client,
      message: /not both/,
    },
    {
      flags: { ...TAKEOVER_CLI_FLAGS, deviceKey: 'android:mobile:a' },
      client,
      message: /lease backend/,
    },
    {
      flags: { ...TAKEOVER_CLI_FLAGS, platform: 'android', serial: 'serial-1' },
      client: ambiguousClient,
      message: /Several devices match/,
    },
    {
      flags: { ...TAKEOVER_CLI_FLAGS, platform: 'android', serial: 'missing' },
      client: {
        ...client,
        devices: { ...client.devices, list: vi.fn(async () => []) },
      },
      message: /No device matches/,
    },
  ];
  for (const { flags, client: caseClient, message } of cases) {
    await assert.rejects(
      takeoverCommand({
        host: createTestHostEnvironment(),
        client: caseClient,
        flags,
        positionals: ['hold'],
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'INVALID_ARGS');
        assert.match((error as Error).message, message);
        return true;
      },
    );
  }
  assert.equal(mocks.putHostHumanControlHold.mock.calls.length, 0);
});

test('takeover hold rejects positional arguments', async () => {
  const { client } = clientForTest();
  await assert.rejects(
    takeoverCommand({
      host: createTestHostEnvironment(),
      client,
      flags: { ...TAKEOVER_CLI_FLAGS },
      positionals: ['hold', 'extra'],
    }),
    { code: 'INVALID_ARGS' },
  );
  assert.equal(mocks.resolveHostHoldAdmin.mock.calls.length, 0);
});

test('takeover release without a lease scope removes a host hold', async () => {
  const { client, transport } = clientForTest();
  await takeoverCommand({
    host: createTestHostEnvironment(),
    client,
    flags: { ...TAKEOVER_CLI_FLAGS },
    positionals: ['release', 'takeover-1'],
  });
  assert.deepEqual(mocks.removeHostHumanControlHold.mock.calls[0]?.[0], {
    connection: { baseUrl: 'http://127.0.0.1:4310', token: 'host-token' },
    holdId: 'takeover-1',
  });
  assert.equal(transport.mock.calls.length, 0);
});

test('takeover release keeps the lease-owned path when a session names the request', async () => {
  const { client, transport } = clientForTest();
  await takeoverCommand({
    host: createTestHostEnvironment(),
    client,
    flags: { ...TAKEOVER_CLI_FLAGS, session: 'remote-session' },
    positionals: ['release', 'operator-1'],
  });
  assert.equal(mocks.removeHostHumanControlHold.mock.calls.length, 0);
  assert.deepEqual(
    transport.mock.calls.map(([req]) => req.positionals),
    [['remove', 'operator-1']],
  );
});

test('takeover hold output names the release command', () => {
  assert.match(renderTakeoverHold(HUMAN_CONTROL_HOLD), /Human control active for ios:mobile:sim-1/);
  assert.match(renderTakeoverHold(HUMAN_CONTROL_HOLD), /takeover release operator-1/);
  assert.match(renderTakeoverHold(HUMAN_CONTROL_HOLD), /Hold: operator-1/);
});
