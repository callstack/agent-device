import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { writeCliSession } from '../cli/auth-session.ts';
import { runCliCapture } from './cli-capture.ts';
import { seedConnectionState } from './remote-connection.fixtures.ts';

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
    for (const command of ['snapshot', 'disconnect']) {
      const result = await runCliCapture([command, '--json'], {
        env: {
          AGENT_DEVICE_STATE_DIR: stateDir,
          AGENT_DEVICE_SESSION: session,
          AGENT_DEVICE_CLOUD_BASE_URL: cloudBaseUrl,
        },
      });
      expect(JSON.parse(result.stdout).error.message).toContain('connect cloud --force');
      expect(result.calls).toEqual([]);
    }
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
