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

// No plugin is installed in this file, and `close` and `disconnect` load no plugin store. The
// stored connection is what a `connect limrun` with the plugin installed wrote.
function storedLimrunConnection() {
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
      leaseProvider: 'limrun',
      forgetsEndedLease: true,
      platform: 'android',
      connectedAt: now,
      updatedAt: now,
    },
  });
  return { root, home, project, stateDir };
}

test('close forgets an ended Limrun lease without loading the plugin store', async () => {
  const { root, home, project, stateDir } = storedLimrunConnection();
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

test('disconnect removes a stored Limrun connection after the plugin is uninstalled', async () => {
  const { root, home, project, stateDir } = storedLimrunConnection();
  const result = await runCliCapture(
    ['disconnect', '--session', 'limrun-close', '--state-dir', stateDir, '--json'],
    { cwd: project, env: { HOME: home } },
  );

  assert.equal(result.code, null, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).data.connected, false);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'limrun-close' }), null);
  fs.rmSync(root, { recursive: true, force: true });
});
