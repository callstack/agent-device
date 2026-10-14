import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import fs from 'node:fs';
import { runCliCapture, type CapturedCliRun } from './cli-capture.ts';
import {
  connectionWorkspace,
  createTestClient,
  seedConnectionState,
  type StoredConnectionSeed,
} from './remote-connection.fixtures.ts';
import { materializeRemoteConnectionForCommand } from '../cli/commands/connection-runtime.ts';
import { readRemoteConnectionState } from '../remote/remote-connection-state.ts';
import type { DaemonResponse } from '../daemon-client/daemon-client.ts';

const emitDiagnostic = vi.hoisted(() => vi.fn());

vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  emitDiagnostic.mockImplementation(actual.emitDiagnostic);
  return { ...actual, emitDiagnostic };
});

function runCliWithDaemonStartupFailure(argv: string[]): Promise<CapturedCliRun> {
  return runCliCapture(argv, async () => {
    throw new AppError('COMMAND_FAILED', 'Failed to start daemon', {
      infoPath: '/tmp/daemon.json',
      hint: 'stale daemon info',
    });
  });
}

async function runCliCaptureWithErrorDetails(
  argv: string[],
  details: Record<string, unknown>,
  message = 'Failed to start daemon',
): Promise<CapturedCliRun> {
  return runCliCapture(argv, async () => {
    throw new AppError('COMMAND_FAILED', message, details);
  });
}

test('close treats daemon startup failure as no-op', async () => {
  const result = await runCliWithDaemonStartupFailure(['close']);
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('close --json treats daemon startup failure as no-op success', async () => {
  const result = await runCliWithDaemonStartupFailure(['close', '--json']);
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.success, true);
  assert.equal(payload.data.closed, 'session');
  assert.equal(payload.data.source, 'no-daemon');
  assert.equal(result.stderr, '');
});

test('close treats lock-only daemon startup failure as no-op', async () => {
  const result = await runCliCaptureWithErrorDetails(['close'], {
    lockPath: '/tmp/daemon.lock',
    hint: 'stale daemon lock',
  });
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('close treats structured daemon startup failure as no-op without relying on message text', async () => {
  const result = await runCliCaptureWithErrorDetails(
    ['close'],
    {
      kind: 'daemon_startup_failed',
      lockPath: '/tmp/daemon.lock',
    },
    'daemon bootstrap failed',
  );
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('close --shutdown is accepted as a valid flag', async () => {
  const result = await runCliWithDaemonStartupFailure(['close', '--shutdown']);
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('close --shutdown --json treats daemon startup failure as no-op success', async () => {
  const result = await runCliWithDaemonStartupFailure(['close', '--shutdown', '--json']);
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.success, true);
  assert.equal(payload.data.closed, 'session');
  assert.equal(payload.data.source, 'no-daemon');
  assert.equal(result.stderr, '');
});

const PROXY_LEASE_ID = 'abc123abc123abc1';

function seedProxyConnection(overrides: Partial<StoredConnectionSeed> = {}): {
  stateDir: string;
  remoteConfigPath: string;
} {
  const { stateDir, remoteConfigPath } = connectionWorkspace('agent-device-close-proxy-');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-proxy',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'proxy',
      runId: 'proxy-client-1',
      leaseId: PROXY_LEASE_ID,
      leaseBackend: 'ios-instance',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      deviceKey: 'ios:mobile:SIM-001',
      platform: 'ios',
      ...overrides,
    },
  });
  return { stateDir, remoteConfigPath };
}

function closeProxySession(
  stateDir: string,
  releaseResponse: DaemonResponse = { ok: true, data: { released: false } },
): Promise<CapturedCliRun> {
  return runCliCapture(
    ['close', '--state-dir', stateDir, '--session', 'adc-proxy', '--json'],
    async (req) =>
      req.command === 'lease_release'
        ? releaseResponse
        : { ok: true, data: { session: 'adc-proxy' } },
  );
}

test('proxy close sends lease_release for the stored lease and forgets it locally', async () => {
  const { stateDir } = seedProxyConnection();
  const result = await closeProxySession(stateDir);
  assert.equal(result.code, null);
  assert.deepEqual(
    result.calls.map((call) => call.command),
    ['close', 'lease_release'],
  );
  assert.equal(result.calls[1]?.flags?.leaseId, PROXY_LEASE_ID);
  assert.equal(result.calls[1]?.meta?.deviceKey, 'ios:mobile:SIM-001');
  assert.equal(JSON.parse(result.stdout).success, true);
  const state = readRemoteConnectionState({ stateDir, session: 'adc-proxy' });
  assert.equal(state?.leaseId, undefined);
  assert.equal(state?.leaseProvider, 'proxy');
});

test('proxy close succeeds and forgets the lease when the release finds no lease', async () => {
  const { stateDir } = seedProxyConnection();
  const result = await closeProxySession(stateDir, {
    ok: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'Lease is not active',
      details: { reason: 'LEASE_NOT_FOUND' },
    },
  });
  assert.equal(result.code, null);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).success, true);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-proxy' })?.leaseId, undefined);
  const releaseFailure = emitDiagnostic.mock.calls
    .map(([event]) => event)
    .find((event) => event.phase === 'proxy_lease_release_after_close_failed');
  assert.deepEqual(releaseFailure?.data, {
    session: 'adc-proxy',
    leaseId: PROXY_LEASE_ID,
    code: 'UNAUTHORIZED',
    reason: 'LEASE_NOT_FOUND',
  });
});

test('proxy close keeps a lease the daemon retained on close, as heartbeats reported it', async () => {
  const { stateDir, remoteConfigPath } = seedProxyConnection();
  await materializeRemoteConnectionForCommand({
    command: 'snapshot',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      session: 'adc-proxy',
    },
    client: createTestClient({
      heartbeat: async (request) => ({
        leaseId: request.leaseId,
        tenantId: 'proxy',
        runId: 'proxy-client-1',
        backend: 'ios-instance',
        retainOnClose: true,
      }),
    }),
  });
  const result = await closeProxySession(stateDir);
  assert.equal(result.code, null);
  assert.deepEqual(
    result.calls.map((call) => call.command),
    ['close'],
  );
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'adc-proxy' })?.leaseId,
    PROXY_LEASE_ID,
  );
});

test('close sends no lease_release for host-allocated or non-proxy leases', async () => {
  for (const overrides of [
    { leaseBackend: 'macos-app', platform: 'macos', deviceKey: 'com.example.app@4242' },
    { leaseProvider: undefined },
  ] satisfies Partial<StoredConnectionSeed>[]) {
    const { stateDir } = seedProxyConnection(overrides);
    const result = await closeProxySession(stateDir);
    assert.equal(result.code, null);
    assert.deepEqual(
      result.calls.map((call) => call.command),
      ['close'],
    );
    assert.equal(
      readRemoteConnectionState({ stateDir, session: 'adc-proxy' })?.leaseId,
      PROXY_LEASE_ID,
    );
  }
});

test('local close sends no lease_release', async () => {
  const result = await runCliCapture(['close', '--json'], {
    stateDirPrefix: 'agent-device-close-local-',
    defaultResponse: { ok: true, data: { session: 'default' } },
  });
  assert.equal(result.code, null);
  assert.deepEqual(
    result.calls.map((call) => call.command),
    ['close'],
  );
});
