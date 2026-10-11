// Human rendering of `connection status` (#3420): the shipped status block is the operator-
// facing projection of a stored remote connection, so its pending-vs-bound lease axes, the
// metro prepared marker, and the deferred notices are pinned through the CLI route.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { runCliCapture } from '../../../__tests__/cli-capture.ts';
import {
  hashRemoteConfigFile,
  writeRemoteConnectionState,
  type RemoteConnectionState,
} from '../../../remote/remote-connection-state.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

type ConnectionFixture = {
  stateDir: string;
  remoteConfigPath: string;
};

function connectionFixture(prefix: string): ConnectionFixture {
  const tempRoot = mkdtempForTestSync(prefix);
  return {
    stateDir: path.join(tempRoot, '.state'),
    remoteConfigPath: path.join(tempRoot, 'remote.json'),
  };
}

function seedConnection(
  fixture: ConnectionFixture,
  remoteConfig: Record<string, unknown>,
  state: Partial<RemoteConnectionState> & Pick<RemoteConnectionState, 'session'>,
): void {
  fs.writeFileSync(fixture.remoteConfigPath, JSON.stringify(remoteConfig));
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir: fixture.stateDir,
    state: {
      version: 1,
      remoteConfigPath: fixture.remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(fixture.remoteConfigPath),
      tenant: 'acme',
      runId: 'run-123',
      connectedAt: now,
      updatedAt: now,
      ...state,
    },
  });
}

test('connection status without a stored connection says so for the default session', async () => {
  const fixture = connectionFixture('agent-device-connection-status-none-');
  const result = await runCliCapture(['connection', 'status', '--state-dir', fixture.stateDir]);

  assert.equal(result.code, null);
  assert.equal(result.stdout, 'No remote connection for "default".\n');
});

test('connection status rejects a subcommand other than status', async () => {
  const fixture = connectionFixture('agent-device-connection-status-invalid-');
  const result = await runCliCapture(['connection', 'rotate', '--state-dir', fixture.stateDir]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /INVALID_ARGS/);
  assert.match(result.stderr, /connection accepts only: status/);
});

test('connection status renders a pending lease and the deferred allocation notice', async () => {
  const fixture = connectionFixture('agent-device-connection-status-pending-');
  seedConnection(
    fixture,
    { daemonBaseUrl: 'https://daemon.example.test' },
    {
      session: 'adc-pending',
      leaseProvider: 'proxy',
    },
  );

  const result = await runCliCapture([
    'connection',
    'status',
    '--state-dir',
    fixture.stateDir,
    '--session',
    'adc-pending',
  ]);

  assert.equal(result.code, null);
  assert.match(result.stdout, /Configured remote session "adc-pending"\./);
  assert.match(result.stdout, /tenant=acme runId=run-123 leaseId=pending backend=pending/);
  assert.match(result.stdout, new RegExp(`remoteConfig=${fixture.remoteConfigPath}`));
  assert.match(result.stdout, /metro=not-prepared/);
  assert.match(result.stdout, /No live device session has been created/);
});

test('connection status renders a bound lease and a prepared runtime without notices', async () => {
  const fixture = connectionFixture('agent-device-connection-status-bound-');
  seedConnection(
    fixture,
    { daemonBaseUrl: 'https://daemon.example.test' },
    {
      session: 'adc-bound',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
      leaseProvider: 'proxy',
      runtime: { platform: 'android' },
    },
  );

  const result = await runCliCapture([
    'connection',
    'status',
    '--state-dir',
    fixture.stateDir,
    '--session',
    'adc-bound',
  ]);

  assert.equal(result.code, null);
  assert.match(result.stdout, /tenant=acme runId=run-123 leaseId=lease-1 backend=android-instance/);
  assert.match(result.stdout, /metro=prepared/);
  assert.doesNotMatch(result.stdout, /No live device session has been created/);
  assert.doesNotMatch(result.stdout, /Metro runtime is not prepared yet/);
});

test('connection status re-emits the deferred Metro notice for a bound lease', async () => {
  const fixture = connectionFixture('agent-device-connection-status-metro-');
  seedConnection(
    fixture,
    {
      daemonBaseUrl: 'https://daemon.example.test',
      metroPublicBaseUrl: 'https://sandbox.example.test',
    },
    {
      session: 'adc-metro',
      leaseId: 'lease-2',
      leaseBackend: 'android-instance',
      leaseProvider: 'proxy',
    },
  );

  const result = await runCliCapture([
    'connection',
    'status',
    '--state-dir',
    fixture.stateDir,
    '--session',
    'adc-metro',
  ]);

  assert.equal(result.code, null);
  assert.match(result.stdout, /metro=not-prepared/);
  assert.match(result.stdout, /Metro runtime is not prepared yet/);
  assert.match(
    result.stdout,
    new RegExp(
      `agent-device metro prepare --remote-config ${fixture.remoteConfigPath} --session adc-metro`,
    ),
  );
});
