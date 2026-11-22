import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempWorkspace } from '@agent-device/test-kit';
import {
  hashRemoteConfigFile,
  readRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { runCliCapture } from './cli-capture.ts';

test('an unnamed disconnect removes an invalid default record before it disconnects the active session', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const connectionsDir = path.join(stateDir, 'remote-connections');
  fs.mkdirSync(connectionsDir, { recursive: true });
  const remoteConfig = path.join(project, 'agent-device.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({ daemonBaseUrl: 'http://remote-mac.example.test:9124/agent-device' }),
    'utf8',
  );
  const record = (session: string) => ({
    version: 1,
    session,
    remoteConfigPath: remoteConfig,
    remoteConfigHash: hashRemoteConfigFile(remoteConfig),
    tenant: 'acme',
    runId: `run-${session}`,
    connectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const defaultPath = path.join(connectionsDir, 'default.json');
  const teamPath = path.join(connectionsDir, 'team.json');
  const activePath = path.join(connectionsDir, '.active-session.json');
  fs.writeFileSync(defaultPath, JSON.stringify({ ...record('default'), updatedAt: null }), 'utf8');
  fs.writeFileSync(teamPath, JSON.stringify(record('team')), 'utf8');
  fs.writeFileSync(activePath, JSON.stringify({ session: 'team' }), 'utf8');

  const disconnected = await runCliCapture(['disconnect', '--state-dir', stateDir, '--json'], {
    cwd: project,
    env: { HOME: home },
  });

  assert.equal(disconnected.code, null);
  assert.equal(JSON.parse(disconnected.stdout).data.session, 'team');
  assert.equal(fs.existsSync(defaultPath), false);
  assert.equal(fs.existsSync(teamPath), false);
  assert.equal(fs.existsSync(activePath), false);

  fs.rmSync(root, { recursive: true, force: true });
});

// A build that sanitized session names wrote the session `.active-session` to exactly the pointer
// path. The unnamed disconnect claims it there, and that claim drives the client and the teardown.
test.each([
  { leaseProvider: undefined, refusal: undefined },
  { leaseProvider: 'proxy', refusal: 'REMOTE_SESSION_REQUIRED' },
])(
  'an unnamed disconnect of the older .active-session record at the pointer path (leaseProvider $leaseProvider)',
  async ({ leaseProvider, refusal }) => {
    const { root, home, project } = makeTempWorkspace();
    const stateDir = path.join(root, 'state');
    const connectionsDir = path.join(stateDir, 'remote-connections');
    fs.mkdirSync(connectionsDir, { recursive: true });
    const remoteConfig = path.join(project, 'agent-device.remote.json');
    fs.writeFileSync(
      remoteConfig,
      JSON.stringify({ daemonBaseUrl: 'http://remote-mac.example.test:9124/agent-device' }),
      'utf8',
    );
    const session = '.active-session';
    fs.writeFileSync(
      path.join(connectionsDir, '.active-session.json'),
      JSON.stringify({
        version: 1,
        session,
        remoteConfigPath: remoteConfig,
        remoteConfigHash: hashRemoteConfigFile(remoteConfig),
        tenant: 'acme',
        runId: 'run-legacy',
        ...(leaseProvider ? { leaseProvider } : {}),
        connectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );

    const disconnected = await runCliCapture(['disconnect', '--state-dir', stateDir, '--json'], {
      cwd: project,
      env: { HOME: home },
    });

    if (refusal) {
      assert.equal(disconnected.code, 1);
      assert.equal(JSON.parse(disconnected.stdout).error.details.reason, refusal);
      assert.equal(readRemoteConnectionState({ stateDir, session })?.runId, 'run-legacy');
    } else {
      assert.equal(disconnected.code, null);
      assert.equal(JSON.parse(disconnected.stdout).data.session, session);
      assert.equal(readRemoteConnectionState({ stateDir, session }), null);
      assert.deepEqual(fs.readdirSync(connectionsDir), []);
    }

    fs.rmSync(root, { recursive: true, force: true });
  },
);
