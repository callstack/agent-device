import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import fs from 'node:fs';
import path from 'node:path';
import { runCliCapture, type CapturedCliRun } from './cli-capture.ts';
import {
  connectionWorkspace,
  seedConnectionState,
  type StoredConnectionSeed,
} from './remote-connection.fixtures.ts';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import type { DaemonRequest, DaemonResponse } from '../daemon-client/daemon-client.ts';

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
const ENDED_LEASES = [{ leaseId: PROXY_LEASE_ID, outcome: 'released' }];

function seedProxyConnection(overrides: Partial<StoredConnectionSeed> = {}): string {
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
  return stateDir;
}

function storedLeaseId(stateDir: string): string | undefined {
  return readRemoteConnectionState({ stateDir, session: 'adc-proxy' })?.leaseId;
}

function runProxyCli(
  stateDir: string,
  argv: string[],
  respond: (req: Omit<DaemonRequest, 'token'>) => DaemonResponse,
): Promise<CapturedCliRun> {
  return runCliCapture(
    [...argv, '--state-dir', stateDir, '--session', 'adc-proxy', '--json'],
    async (req) =>
      req.command === 'lease_heartbeat'
        ? {
            ok: true,
            data: {
              lease: {
                leaseId: PROXY_LEASE_ID,
                tenantId: 'proxy',
                runId: 'proxy-client-1',
                backend: 'ios-instance',
              },
            },
          }
        : respond(req),
  );
}

test('proxy close forgets the stored lease the daemon reports ended, and sends no release', async () => {
  const stateDir = seedProxyConnection();
  const result = await runProxyCli(stateDir, ['close'], () => ({
    ok: true,
    data: { session: 'adc-proxy', endedLeases: ENDED_LEASES },
  }));
  assert.equal(result.code, null);
  assert.deepEqual(
    result.calls.map((call) => call.command),
    ['close'],
  );
  assert.equal(storedLeaseId(stateDir), undefined);
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'adc-proxy' })?.leaseProvider,
    'proxy',
  );
});

test('a failed proxy close forgets the stored lease the daemon already ended', async () => {
  const stateDir = seedProxyConnection();
  const result = await runProxyCli(stateDir, ['close'], () => ({
    ok: false,
    error: {
      code: 'DEVICE_UNAVAILABLE',
      message: 'platform close failed',
      details: { endedLeases: ENDED_LEASES },
    },
  }));
  assert.equal(result.code, 1);
  assert.equal(storedLeaseId(stateDir), undefined);
});

test('a proxy batch forgets the stored lease its reply reports ended by a close step', async () => {
  const closeStep = { step: 1, command: 'close', ok: true, data: {}, durationMs: 1 };
  const batchReplies: DaemonResponse[] = [
    {
      ok: true,
      data: {
        total: 1,
        executed: 1,
        totalDurationMs: 1,
        results: [closeStep],
        endedLeases: ENDED_LEASES,
      },
    },
    {
      ok: false,
      error: {
        code: 'SESSION_NOT_FOUND',
        message: 'Batch failed at step 2 (snapshot): No active session',
        details: { step: 2, partialResults: [closeStep], endedLeases: ENDED_LEASES },
      },
    },
  ];
  for (const reply of batchReplies) {
    const stateDir = seedProxyConnection();
    const result = await runProxyCli(
      stateDir,
      ['batch', '--steps', '[{"command":"close","input":{}},{"command":"snapshot","input":{}}]'],
      () => reply,
    );
    assert.deepEqual(
      result.calls.map((call) => call.command).filter((command) => command !== 'lease_heartbeat'),
      ['batch'],
    );
    assert.equal(storedLeaseId(stateDir), undefined);
  }
});

test('a proxy replay forgets the stored lease its reply reports ended by the script close', async () => {
  const stateDir = seedProxyConnection();
  const scriptPath = path.join(stateDir, 'open-close.ad');
  fs.writeFileSync(scriptPath, 'open "com.apple.Preferences"\nclose\n');
  const result = await runProxyCli(stateDir, ['replay', scriptPath], () => ({
    ok: true,
    data: { replayed: 2, healed: 0, session: 'adc-proxy', endedLeases: ENDED_LEASES },
  }));
  assert.equal(result.code, null);
  assert.deepEqual(
    result.calls.map((call) => call.command).filter((command) => command !== 'lease_heartbeat'),
    ['replay'],
  );
  assert.equal(storedLeaseId(stateDir), undefined);
});
