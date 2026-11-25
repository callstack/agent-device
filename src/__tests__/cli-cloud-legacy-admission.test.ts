import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import * as hostFiles from '@agent-device/host-kit/file';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { writeCliSession } from '../cli/auth-session.ts';
import { resolveCloudAdmission } from '../cli/connection/active-connection.ts';
import {
  prepareCloudConnection,
  readCloudConnection,
  withConnectionLock,
  writeCloudConnection,
} from '../cli/connection/cloud-connection-record.ts';
import { runCliCapture } from './cli-capture.ts';
import { seedConnectionState } from './remote-connection.fixtures.ts';

test('a selected direct route rechecks ownership before handing off a request', async () => {
  const stateDir = mkdtempForTestSync('cloud-handoff-contention-');
  const location = { stateDir, session: 'saved-direct' };
  const admit = await resolveCloudAdmission({
    command: 'snapshot',
    usesSessions: true,
    ...location,
    binding: undefined,
    remoteRoute: true,
  });
  const request = {
    platform: 'ios',
    vendor: undefined,
    maxMinutes: undefined,
    accepts: ['agent-device-daemon'],
  } as const;
  await withConnectionLock(stateDir, location.session, async () => {
    writeCloudConnection(
      location,
      prepareCloudConnection(location.session, request, 'https://cloud.example', null),
    );
  });
  const send = vi.fn(async () => undefined);
  expect(admit).toBeDefined();
  await expect(admit!(send)).rejects.toMatchObject({
    details: { reason: 'cloud_connection_owns_session' },
  });
  expect(send).not.toHaveBeenCalled();
});

test('connection commands refuse lock contention before and during allocation', async () => {
  const location = { stateDir: mkdtempForTestSync('cloud-disconnect-contention-'), session: 'qa' };
  const origin = 'https://cloud.example';
  const id = '00000000-0000-4000-8000-000000000001';
  const pending = {
    ...prepareCloudConnection(
      location.session,
      {
        platform: 'ios',
        vendor: undefined,
        maxMinutes: undefined,
        accepts: ['agent-device-daemon'],
      },
      origin,
      null,
    ),
    id,
  };
  const env = {
    AGENT_DEVICE_STATE_DIR: location.stateDir,
    AGENT_DEVICE_CLOUD_BASE_URL: origin,
    AGENT_DEVICE_CLOUD_API_KEY_ORIGIN: origin,
    AGENT_DEVICE_CLOUD_API_KEY: 'fixture-cloud-api-key',
  };
  const disconnect = () =>
    runCliCapture(['disconnect', '--session', location.session, '--json'], { env });
  const connect = () =>
    runCliCapture(
      ['connect', 'cloud', '--platform', 'ios', '--session', location.session, '--json'],
      {
        env,
      },
    );
  const fetchMock = vi.fn(
    async (_url: URL, _init: RequestInit) => new Response(null, { status: 204 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const acquire = hostFiles.acquireProcessLock;
  const acquireSpy = vi
    .spyOn(hostFiles, 'acquireProcessLock')
    .mockImplementation((options) => acquire({ ...options, timeoutMs: 0 }));
  try {
    await withConnectionLock(location.stateDir, location.session, async () => {
      for (const command of [disconnect, connect]) {
        const blocked = await command();
        expect(JSON.parse(blocked.stdout).error).toMatchObject({
          retriable: true,
          details: { reason: 'connection_busy' },
        });
      }
      writeCloudConnection(location, pending);
      const blocked = await disconnect();
      expect(JSON.parse(blocked.stdout).error).toMatchObject({
        code: 'COMMAND_FAILED',
        retriable: true,
        details: { reason: 'cloud_connection_owns_session' },
      });
      const duplicate = await connect();
      expect(JSON.parse(duplicate.stdout).error).toMatchObject({
        retriable: true,
        details: { reason: 'cloud_connect_pending_conflict' },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(readCloudConnection(location)).toEqual(pending);
    });
    expect((await disconnect()).code).toBeNull();
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['DELETE']);
    expect(readCloudConnection(location)).toBeNull();
  } finally {
    acquireSpy.mockRestore();
    vi.unstubAllGlobals();
  }
});

test('disconnect waits for the lock on a committed cloud session', async () => {
  const location = { stateDir: mkdtempForTestSync('cloud-committed-contention-'), session: 'qa' };
  const origin = 'https://cloud.example';
  const env = {
    AGENT_DEVICE_STATE_DIR: location.stateDir,
    AGENT_DEVICE_CLOUD_BASE_URL: origin,
    AGENT_DEVICE_CLOUD_API_KEY_ORIGIN: origin,
    AGENT_DEVICE_CLOUD_API_KEY: 'fixture-cloud-api-key',
  };
  const record = prepareCloudConnection(
    location.session,
    { platform: 'ios', accepts: ['agent-device-daemon'], vendor: undefined, maxMinutes: undefined },
    origin,
    null,
  );
  writeCloudConnection(location, {
    ...record,
    phase: 'committed',
    id: '00000000-0000-4000-8000-000000000001',
  });
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  let observedContention!: () => void;
  const contention = new Promise<void>((resolve) => {
    observedContention = resolve;
  });
  const acquire = hostFiles.acquireProcessLock;
  const acquireSpy = vi.spyOn(hostFiles, 'acquireProcessLock').mockImplementation((options) =>
    acquire({
      ...options,
      onContention: () => {
        observedContention();
        options.onContention?.();
      },
    }),
  );
  try {
    const disconnect = await withConnectionLock(location.stateDir, location.session, async () => {
      const result = runCliCapture(['disconnect', '--session', location.session, '--json'], {
        env,
      });
      await contention;
      return { result };
    });
    expect(JSON.parse((await disconnect.result).stdout).data.released).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readCloudConnection(location)).toBeNull();
  } finally {
    acquireSpy.mockRestore();
    vi.unstubAllGlobals();
  }
});

test('legacy hosted profiles do not refresh credentials or dispatch device commands', async () => {
  const stateDir = mkdtempForTestSync('cloud-legacy-admission-');
  const session = 'legacy-fixture';
  const daemonBaseUrl = 'https://daemon.example';
  const cloudBaseUrl = 'https://cloud.example';
  const generated = path.join(stateDir, 'remote-connections', 'generated');
  fs.mkdirSync(generated, { recursive: true });
  const remoteConfigPath = path.join(generated, 'cloud-abcdef123456.json');
  const scope = { session, tenant: 'fixture-tenant', runId: 'fixture-run' };
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ ...scope, daemonBaseUrl }));
  seedConnectionState({
    stateDir,
    state: {
      ...scope,
      remoteConfigPath,
      leaseId: 'fixture-legacy-lease',
      daemon: { baseUrl: daemonBaseUrl },
    },
  });
  writeCliSession({
    stateDir,
    session: {
      version: 2,
      id: 'fixture-login',
      cloudBaseUrl,
      refreshCredential: 'fixture-refresh',
      createdAt: new Date().toISOString(),
    },
  });
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  try {
    const env = {
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_SESSION: session,
      AGENT_DEVICE_CLOUD_BASE_URL: cloudBaseUrl,
    };
    const snapshot = await runCliCapture(['snapshot', '--json'], { env });
    expect(JSON.parse(snapshot.stdout).error.message).toContain('connect cloud --force');
    expect(snapshot.calls).toEqual([]);
    for (const override of [
      {},
      {
        AGENT_DEVICE_DAEMON_BASE_URL: 'https://other.example',
        AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'fixture-key',
      },
    ]) {
      const refused = await runCliCapture(['disconnect', '--json'], {
        env: { ...env, ...override },
      });
      expect(JSON.parse(refused.stdout).error.code, refused.stdout).toBe('UNAUTHORIZED');
      expect(refused.calls).toEqual([]);
    }
    const args = ['disconnect', '--json'];
    const teardownEnv = {
      ...env,
      AGENT_DEVICE_DAEMON_BASE_URL: daemonBaseUrl,
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'fixture-key',
    };
    const failed = await runCliCapture(args, {
      env: teardownEnv,
      sendToDaemon: async () => ({
        ok: false,
        error: { code: 'COMMAND_FAILED', message: 'fixture failure' },
      }),
    });
    expect(failed.code).toBe(1);
    expect(readRemoteConnectionState({ stateDir, session })?.leaseId).toBe('fixture-legacy-lease');
    const released = await runCliCapture(args, {
      env: teardownEnv,
      sendToDaemon: async () => ({ ok: true, data: { released: true } }),
    });
    expect(released.code, released.stdout + released.stderr).toBeNull();
    expect(released.calls.map((call) => call.command)).toEqual(['lease_release']);
    expect(readRemoteConnectionState({ stateDir, session })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

test('bare connect with a configured daemon endpoint keeps its own scope', async () => {
  const workspace = mkdtempForTestSync('configured-daemon-connect-');
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  try {
    const env = {
      AGENT_DEVICE_STATE_DIR: workspace,
      AGENT_DEVICE_SESSION: 'direct-fixture',
      AGENT_DEVICE_DAEMON_BASE_URL: 'https://daemon.example/rpc',
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'fixture-daemon-key',
    };
    const result = await runCliCapture(
      ['connect', '--tenant', 'fixture-tenant', '--run-id', 'fixture-run', '--json'],
      { env },
    );
    expect(result.code, result.stdout + result.stderr).toBeNull();
    const state = readRemoteConnectionState({ stateDir: workspace, session: 'direct-fixture' });
    expect(state).toMatchObject({
      tenant: 'fixture-tenant',
      runId: 'fixture-run',
      daemon: { baseUrl: 'https://daemon.example/rpc' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
