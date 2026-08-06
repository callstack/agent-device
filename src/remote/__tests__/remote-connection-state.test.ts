import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTest } from '../../__tests__/test-utils/tmp-dir.ts';
import {
  buildRemoteConnectionDaemonState,
  hashRemoteConfigFile,
  resolveRemoteConnectionDefaults,
  writeRemoteConnectionState,
  type RemoteConnectionState,
} from '../remote-connection-state.ts';

// Regression coverage for ADR 0007: generated connection profiles must strip
// the daemon bearer token. `connect` used to write it straight into the
// persisted connection-state file; these tests guard against that shadow
// coming back.

const FAKE_DAEMON_TOKEN = 'test-not-a-real-daemon-token';

test('buildRemoteConnectionDaemonState does not persist the daemon auth token', () => {
  const daemon = buildRemoteConnectionDaemonState({
    daemonBaseUrl: 'https://daemon.example.test',
    daemonAuthToken: FAKE_DAEMON_TOKEN,
    daemonTransport: 'http',
    daemonServerMode: 'http',
  });

  assert.equal(Object.hasOwn(daemon ?? {}, 'authToken'), false);
  assert.equal(daemon?.baseUrl, 'https://daemon.example.test');
  assert.equal(daemon?.transport, 'http');
  assert.equal(daemon?.serverMode, 'http');
});

test('written connection state contains no daemon auth token', async () => {
  const tempRoot = await mkdtempForTest('agent-device-remote-connection-state-write-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, '{}');

  const daemon = buildRemoteConnectionDaemonState({
    daemonBaseUrl: 'https://daemon.example.test',
    daemonAuthToken: FAKE_DAEMON_TOKEN,
    daemonTransport: 'http',
    daemonServerMode: 'http',
  });
  const now = new Date().toISOString();
  const state: RemoteConnectionState = {
    version: 1,
    session: 'adc-write-test',
    remoteConfigPath,
    remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
    daemon,
    tenant: 'acme',
    runId: 'run-1',
    connectedAt: now,
    updatedAt: now,
  };

  writeRemoteConnectionState({ stateDir, state });

  const writtenPath = path.join(stateDir, 'remote-connections', 'adc-write-test.json');
  const written = fs.readFileSync(writtenPath, 'utf8');
  assert.equal(written.includes(FAKE_DAEMON_TOKEN), false);
  assert.equal(written.includes('authToken'), false);
});

test('resolveRemoteConnectionDefaults falls back to the environment token', async () => {
  const tempRoot = await mkdtempForTest('agent-device-remote-connection-state-defaults-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, '{}');

  const daemon = buildRemoteConnectionDaemonState({
    daemonBaseUrl: 'https://daemon.example.test',
    daemonAuthToken: undefined,
    daemonTransport: 'http',
    daemonServerMode: 'http',
  });
  const now = new Date().toISOString();
  const state: RemoteConnectionState = {
    version: 1,
    session: 'adc-env-fallback',
    remoteConfigPath,
    remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
    daemon,
    tenant: 'acme',
    runId: 'run-1',
    connectedAt: now,
    updatedAt: now,
  };
  writeRemoteConnectionState({ stateDir, state });

  const defaults = resolveRemoteConnectionDefaults({
    stateDir,
    session: 'adc-env-fallback',
    cwd: tempRoot,
    env: { AGENT_DEVICE_DAEMON_AUTH_TOKEN: FAKE_DAEMON_TOKEN },
  });

  assert.equal(defaults?.flags.daemonAuthToken, FAKE_DAEMON_TOKEN);
});
