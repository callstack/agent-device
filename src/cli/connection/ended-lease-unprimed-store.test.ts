import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  hashRemoteConfigFile,
  readRemoteConnectionState,
  writeRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { makeTempWorkspace } from '@agent-device/test-kit';
import { runCliCapture } from '../../__tests__/cli-capture.ts';

const LEASE_ID = 'abc123abc123abc1';

// No plugin is installed in this file, and `close` and `disconnect` load no plugin store.
function storedConnection(leaseProvider = 'limrun') {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = path.join(project, 'limrun.remote.json');
  fs.writeFileSync(remoteConfig, '{}', 'utf8');
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'limrun-close',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: hashRemoteConfigFile(remoteConfig),
      tenant: 'limrun',
      runId: 'run-close',
      leaseId: LEASE_ID,
      leaseBackend: 'android-instance',
      leaseProvider,
      platform: 'android',
      connectedAt: now,
      updatedAt: now,
    },
  });
  // An earlier build of this branch recorded a policy field on the connection. It is ignored now,
  // and a record that still carries it reads as before.
  const connections = path.join(stateDir, 'remote-connections');
  for (const name of fs.readdirSync(connections)) {
    const file = path.join(connections, name);
    if (!fs.statSync(file).isFile()) continue;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.leaseProvider === undefined) continue;
    fs.writeFileSync(file, JSON.stringify({ ...record, forgetsEndedLease: false }));
  }
  return { root, home, project, stateDir };
}

test('close forgets an ended Limrun lease without loading the plugin store', async () => {
  const { root, home, project, stateDir } = storedConnection();
  const result = await runCliCapture(
    ['close', '--session', 'limrun-close', '--state-dir', stateDir, '--json'],
    {
      cwd: project,
      env: { HOME: home },
      defaultResponse: {
        ok: true,
        data: {
          session: 'limrun-close',
          endedLeases: [{ leaseId: LEASE_ID, outcome: 'released' }],
        },
      },
    },
  );

  assert.equal(result.code, null, result.stdout + result.stderr);
  assert.equal(result.calls[0]?.command, 'close');
  const stored = readRemoteConnectionState({ stateDir, session: 'limrun-close' });
  assert.equal(stored?.leaseProvider, 'limrun');
  assert.equal(stored?.leaseId, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

async function closeWithEndedLease(stateDir: string, project: string, home: string) {
  const result = await runCliCapture(
    ['close', '--session', 'limrun-close', '--state-dir', stateDir, '--json'],
    {
      cwd: project,
      env: { HOME: home },
      defaultResponse: {
        ok: true,
        data: {
          session: 'limrun-close',
          endedLeases: [{ leaseId: LEASE_ID, outcome: 'released' }],
        },
      },
    },
  );
  assert.equal(result.code, null, result.stdout + result.stderr);
  return readRemoteConnectionState({ stateDir, session: 'limrun-close' });
}

test('close forgets an ended Limrun lease on a connection that records no policy', async () => {
  // A connection stored before the policy was recorded: the plugin catalog answers for Limrun.
  const { root, home, project, stateDir } = storedConnection();
  assert.equal((await closeWithEndedLease(stateDir, project, home))?.leaseId, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('close keeps the lease of a provider neither a loaded plugin nor the catalog knows', async () => {
  const { root, home, project, stateDir } = storedConnection('custom-provider');
  assert.equal((await closeWithEndedLease(stateDir, project, home))?.leaseId, LEASE_ID);
  fs.rmSync(root, { recursive: true, force: true });
});

test('disconnect removes a stored Limrun connection after the plugin is uninstalled', async () => {
  const { root, home, project, stateDir } = storedConnection();
  const result = await runCliCapture(
    ['disconnect', '--session', 'limrun-close', '--state-dir', stateDir, '--json'],
    { cwd: project, env: { HOME: home } },
  );

  assert.equal(result.code, null, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).data.connected, false);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'limrun-close' }), null);
  fs.rmSync(root, { recursive: true, force: true });
});
