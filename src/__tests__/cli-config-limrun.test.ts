import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  hashRemoteConfigFile,
  readActiveConnectionState,
  writeRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { runCliCapture } from './cli-capture.ts';
import { makeTempWorkspace } from '@agent-device/test-kit';

vi.mock('@agent-device/plugins/store', async (importOriginal) =>
  (await import('./test-utils/limrun-plugin-store.ts')).storeWithLimrunInstalled(
    importOriginal as () => Promise<typeof import('@agent-device/plugins/store')>,
  ),
);

test('Limrun apps lists uploaded assets without allocating an instance', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = path.join(project, 'limrun.remote.json');
  fs.writeFileSync(remoteConfig, '{}', 'utf8');
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'limrun-apps',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: hashRemoteConfigFile(remoteConfig),
      tenant: 'limrun',
      runId: 'run-apps',
      leaseBackend: 'android-instance',
      leaseProvider: 'limrun',
      platform: 'android',
      connectedAt: now,
      updatedAt: now,
    },
  });

  const result = await runCliCapture(
    ['apps', '--session', 'limrun-apps', '--state-dir', stateDir, '--json'],
    {
      cwd: project,
      env: { HOME: home },
      defaultResponse: { ok: true, data: { apps: ['Example.apk'] } },
    },
  );

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.command, 'apps');
  assert.equal(result.calls[0]?.flags?.leaseId, undefined);
  assert.equal(result.calls[0]?.flags?.leaseProvider, 'limrun');
  assert.equal(readActiveConnectionState({ stateDir })?.leaseId, undefined);

  fs.rmSync(root, { recursive: true, force: true });
});

test('materializing a named Limrun connection leaves the newer active connection active and writes nothing', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const limrunConfig = path.join(project, 'limrun.remote.json');
  fs.writeFileSync(limrunConfig, '{}', 'utf8');
  const otherConfig = path.join(project, 'other.remote.json');
  fs.writeFileSync(otherConfig, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  const now = new Date().toISOString();
  const base = { version: 1 as const, connectedAt: now, updatedAt: now };
  // A is a pending Limrun connection; B, saved after it, is providerless and holds the pointer.
  writeRemoteConnectionState({
    stateDir,
    state: {
      ...base,
      session: 'limrun-a',
      remoteConfigPath: limrunConfig,
      remoteConfigHash: hashRemoteConfigFile(limrunConfig),
      tenant: 'limrun',
      runId: 'run-a',
      leaseBackend: 'android-instance',
      leaseProvider: 'limrun',
      platform: 'android',
    },
  });
  writeRemoteConnectionState({
    stateDir,
    state: {
      ...base,
      session: 'other-b',
      remoteConfigPath: otherConfig,
      remoteConfigHash: hashRemoteConfigFile(otherConfig),
      tenant: 'team-b',
      runId: 'run-b',
    },
  });
  const connections = path.join(stateDir, 'remote-connections');
  const snapshot = () =>
    Object.fromEntries(
      fs
        .readdirSync(connections, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => [
          path.relative(connections, path.join(entry.parentPath, entry.name)),
          fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'),
        ]),
    );
  const before = snapshot();

  const result = await runCliCapture(
    ['apps', '--session', 'limrun-a', '--state-dir', stateDir, '--json'],
    {
      cwd: project,
      env: { HOME: home },
      defaultResponse: { ok: true, data: { apps: ['Example.apk'] } },
    },
  );

  assert.equal(result.code, null, result.stdout + result.stderr);
  assert.equal(result.calls[0]?.flags?.leaseProvider, 'limrun');
  assert.equal(readActiveConnectionState({ stateDir })?.session, 'other-b');
  assert.deepEqual(snapshot(), before);

  fs.rmSync(root, { recursive: true, force: true });
});

test('Limrun state keeps explicit connection identity and excludes profile secrets', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = path.join(project, 'limrun.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      tenant: 'profile-tenant',
      runId: 'profile-run',
      session: 'profile-session',
      leaseBackend: 'android-instance',
      leaseProvider: 'limrun',
      platform: 'android',
      daemonAuthToken: 'daemon-secret',
      metroBearerToken: 'metro-secret',
    }),
    'utf8',
  );

  const result = await runCliCapture(
    [
      'apps',
      '--remote-config',
      remoteConfig,
      '--state-dir',
      stateDir,
      '--tenant',
      'cli-tenant',
      '--run-id',
      'cli-run',
      '--session',
      'cli-session',
      '--json',
    ],
    {
      cwd: project,
      env: { HOME: home },
      defaultResponse: { ok: true, data: { apps: [] } },
    },
  );

  assert.equal(result.code, null);
  const state = readActiveConnectionState({ stateDir });
  assert.equal(state?.tenant, 'cli-tenant');
  assert.equal(state?.runId, 'cli-run');
  assert.equal(state?.session, 'cli-session');
  assert.equal(Object.hasOwn(state ?? {}, 'daemonAuthToken'), false);
  assert.equal(Object.hasOwn(state ?? {}, 'metroBearerToken'), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('Limrun open allocates with the exact uploaded asset name', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = path.join(project, 'limrun.remote.json');
  fs.writeFileSync(remoteConfig, JSON.stringify({ providerApp: 'Stale.app.zip' }), 'utf8');
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'limrun-open',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: hashRemoteConfigFile(remoteConfig),
      tenant: 'limrun',
      runId: 'run-open',
      leaseBackend: 'ios-instance',
      leaseProvider: 'limrun',
      platform: 'ios',
      connectedAt: now,
      updatedAt: now,
    },
  });

  const result = await runCliCapture(
    ['open', 'Example.app.zip', '--session', 'limrun-open', '--state-dir', stateDir, '--json'],
    {
      cwd: project,
      env: { HOME: home },
      sendToDaemon: async (req) => {
        if (req.command === 'lease_allocate') {
          return {
            ok: true,
            data: {
              lease: {
                leaseId: 'lease-limrun-open',
                tenantId: 'limrun',
                runId: 'run-open',
                backend: 'ios-instance',
                leaseProvider: 'limrun',
              },
            },
          };
        }
        if (req.command === 'open') return { ok: true, data: { appId: 'com.example.app' } };
        throw new Error(`unexpected daemon command: ${req.command}`);
      },
    },
  );

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0]?.command, 'lease_allocate');
  assert.equal(result.calls[0]?.flags?.providerApp, 'Example.app.zip');
  assert.equal(result.calls[1]?.command, 'open');
  assert.equal(result.calls[1]?.positionals?.[0], 'Example.app.zip');
  assert.equal(result.calls[1]?.flags?.providerApp, undefined);
  assert.equal(readActiveConnectionState({ stateDir })?.leaseId, 'lease-limrun-open');

  fs.rmSync(root, { recursive: true, force: true });
});
