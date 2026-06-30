import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hashRemoteConfigFile,
  readActiveConnectionState,
  readRemoteConnectionState,
} from '../remote/remote-connection-state.ts';
import { runCliCapture, type CapturedDaemonRequest } from './cli-capture.ts';

function makeTempWorkspace(): { root: string; home: string; project: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-config-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { root, home, project };
}

test('CLI merges config defaults with precedence user < project < env < CLI', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.mkdirSync(path.join(home, '.agent-device'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.agent-device', 'config.json'),
    JSON.stringify({ platform: 'ios', session: 'home-session', snapshotDepth: 2 }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({ session: 'project-session', snapshotDepth: 4 }),
    'utf8',
  );

  const result = await runCliCapture(['snapshot', '--depth', '6', '--json'], {
    cwd: project,
    env: {
      HOME: home,
      AGENT_DEVICE_PLATFORM: 'android',
      AGENT_DEVICE_SNAPSHOT_DEPTH: '5',
    },
  });

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.session, 'project-session');
  assert.equal(result.calls[0]?.flags?.platform, 'android');
  assert.equal(result.calls[0]?.flags?.snapshotDepth, 6);

  fs.rmSync(root, { recursive: true, force: true });
});

test('config can set appsFilter through canonical enum values', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.mkdirSync(path.join(home, '.agent-device'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({ appsFilter: 'user-installed' }),
    'utf8',
  );

  const result = await runCliCapture(['apps', '--json'], {
    cwd: project,
    env: { HOME: home },
  });

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.flags?.appsFilter, 'user-installed');

  fs.rmSync(root, { recursive: true, force: true });
});

test('config can provide install-from-source GitHub Actions artifact source', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.mkdirSync(path.join(home, '.agent-device'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({
      platform: 'android',
      installSource: {
        type: 'github-actions-artifact',
        repo: 'thymikee/RNCLI83',
        artifact: 'rn-android-emulator-debug-pr-19',
      },
    }),
    'utf8',
  );

  const result = await runCliCapture(['install-from-source', '--json'], {
    cwd: project,
    env: { HOME: home },
    sendToDaemon: async () => ({
      ok: true,
      data: {
        packageName: 'com.example.demo',
      },
    }),
  });

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.flags?.platform, 'android');
  assert.deepEqual(result.calls[0]?.meta?.installSource, {
    kind: 'github-actions-artifact',
    owner: 'thymikee',
    repo: 'RNCLI83',
    artifactName: 'rn-android-emulator-debug-pr-19',
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test('command-specific config defaults are ignored for commands that do not support them', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.mkdirSync(path.join(home, '.agent-device'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({ snapshotDepth: 4, platform: 'ios' }),
    'utf8',
  );

  const result = await runCliCapture(['open', 'settings', '--json'], {
    cwd: project,
    env: { HOME: home },
  });

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.flags?.platform, 'ios');
  assert.equal(Object.hasOwn(result.calls[0]?.flags ?? {}, 'snapshotDepth'), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('interaction commands preserve remote config defaults', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.mkdirSync(path.join(home, '.agent-device'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({
      daemonBaseUrl: 'https://daemon.example.test',
      daemonAuthToken: 'token-123',
      daemonTransport: 'http',
      tenant: 'tenant-123',
      runId: 'run-123',
      leaseId: 'lease-123',
      platform: 'ios',
    }),
    'utf8',
  );

  const commands = [
    ['press', '10', '20'],
    ['click', '10', '20'],
    ['fill', '10', '20', 'hello'],
    ['longpress', '10', '20'],
    ['get', 'text', '@e1'],
  ];

  for (const command of commands) {
    const result = await runCliCapture([...command, '--json'], {
      cwd: project,
      env: { HOME: home },
    });

    assert.equal(result.code, null, command.join(' '));
    assert.equal(result.calls.length, 1, command.join(' '));
    assert.equal(result.calls[0]?.flags?.daemonBaseUrl, 'https://daemon.example.test');
    assert.equal(result.calls[0]?.flags?.daemonAuthToken, 'token-123');
    assert.equal(result.calls[0]?.flags?.daemonTransport, 'http');
    assert.equal(result.calls[0]?.flags?.tenant, 'tenant-123');
    assert.equal(result.calls[0]?.flags?.runId, 'run-123');
    assert.equal(result.calls[0]?.flags?.leaseId, 'lease-123');
    assert.equal(result.calls[0]?.flags?.platform, 'ios');
  }

  fs.rmSync(root, { recursive: true, force: true });
});

test('normal config can point commands at a direct remote daemon proxy', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.mkdirSync(path.join(home, '.agent-device'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({
      daemonBaseUrl: 'https://example.trycloudflare.com/agent-device',
      daemonAuthToken: 'proxy-token',
    }),
    'utf8',
  );

  const result = await runCliCapture(['devices', '--json'], {
    cwd: project,
    env: { HOME: home },
  });

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.command, 'devices');
  assert.equal(
    result.calls[0]?.flags?.daemonBaseUrl,
    'https://example.trycloudflare.com/agent-device',
  );
  assert.equal(result.calls[0]?.flags?.daemonAuthToken, 'proxy-token');
  assert.equal(Object.hasOwn(result.calls[0]?.flags ?? {}, 'platform'), false);
  assert.equal(Object.hasOwn(result.calls[0]?.flags ?? {}, 'remoteConfig'), false);
  assert.equal(Object.hasOwn(result.calls[0]?.flags ?? {}, 'tenant'), false);
  assert.equal(Object.hasOwn(result.calls[0]?.flags ?? {}, 'runId'), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('explicit --config path overrides default config discovery', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.mkdirSync(path.join(home, '.agent-device'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.agent-device', 'config.json'),
    JSON.stringify({ session: 'home-session' }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({ session: 'project-session' }),
    'utf8',
  );
  const explicitConfig = path.join(root, 'custom-device-config.json');
  fs.writeFileSync(
    explicitConfig,
    JSON.stringify({ session: 'explicit-session', platform: 'apple' }),
    'utf8',
  );

  const result = await runCliCapture(['devices', '--config', explicitConfig, '--json'], {
    cwd: project,
    env: { HOME: home },
  });

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.session, 'explicit-session');
  assert.equal(result.calls[0]?.flags?.platform, 'apple');

  fs.rmSync(root, { recursive: true, force: true });
});

test('AGENT_DEVICE_CONFIG loads an explicit config path', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.mkdirSync(path.join(home, '.agent-device'), { recursive: true });
  const explicitConfig = path.join(home, 'env-config.json');
  fs.writeFileSync(
    explicitConfig,
    JSON.stringify({ session: 'env-explicit-session', platform: 'android' }),
    'utf8',
  );

  const result = await runCliCapture(['devices', '--json'], {
    cwd: project,
    env: { HOME: home, AGENT_DEVICE_CONFIG: '~/env-config.json' },
  });

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.session, 'env-explicit-session');
  assert.equal(result.calls[0]?.flags?.platform, 'android');

  fs.rmSync(root, { recursive: true, force: true });
});

test('active remote connection defaults override generic config and env for remote commands', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.mkdirSync(path.join(home, '.agent-device'), { recursive: true });
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(stateDir, 'remote-connections'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({ session: 'project-session', platform: 'ios' }),
    'utf8',
  );
  const remoteConfig = path.join(project, 'agent-device.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      session: 'remote-session',
      platform: 'android',
      daemonBaseUrl: 'http://remote-mac.example.test:9124/agent-device',
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(stateDir, 'remote-connections', 'env-session.json'),
    JSON.stringify({
      version: 1,
      session: 'env-session',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: hashRemoteConfigFile(remoteConfig),
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-123',
      leaseBackend: 'android-instance',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    'utf8',
  );

  const result = await runCliCapture(['snapshot', '--state-dir', stateDir, '--json'], {
    cwd: project,
    env: {
      HOME: home,
      AGENT_DEVICE_SESSION: 'env-session',
      AGENT_DEVICE_PLATFORM: 'ios',
    },
    sendToDaemon: async (req) => {
      if (req.command === 'lease_heartbeat') {
        return {
          ok: true,
          data: {
            lease: {
              leaseId: 'lease-123',
              tenantId: 'acme',
              runId: 'run-123',
              backend: 'android-instance',
            },
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0]?.command, 'lease_heartbeat');
  assert.equal(result.calls[1]?.session, 'env-session');
  assert.equal(result.calls[1]?.flags?.platform, 'android');
  assert.equal(
    result.calls[1]?.flags?.daemonBaseUrl,
    'http://remote-mac.example.test:9124/agent-device',
  );
  assert.equal(result.calls[0]?.meta?.tenantId, 'acme');
  assert.equal(result.calls[0]?.meta?.leaseId, 'lease-123');
  assert.equal(result.calls[1]?.meta?.tenantId, 'acme');
  assert.equal(result.calls[1]?.meta?.leaseId, 'lease-123');

  fs.rmSync(root, { recursive: true, force: true });
});

test('install-from-source uses active remote connection lease binding', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(stateDir, 'remote-connections'), { recursive: true });
  const remoteConfig = path.join(project, 'agent-device.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: 'http://remote-mac.example.test:9124/agent-device',
      tenant: 'micha-pierzcha-a',
      sessionIsolation: 'tenant',
      runId: 'demo-run-001',
      platform: 'android',
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(stateDir, 'remote-connections', 'default.json'),
    JSON.stringify({
      version: 1,
      session: 'default',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: hashRemoteConfigFile(remoteConfig),
      tenant: 'micha-pierzcha-a',
      runId: 'demo-run-001',
      leaseId: 'lease-demo-001',
      leaseBackend: 'android-instance',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    'utf8',
  );

  const calls: CapturedDaemonRequest[] = [];
  const result = await runCliCapture(
    ['install-from-source', 'https://example.com/app.apk', '--state-dir', stateDir, '--json'],
    {
      cwd: project,
      env: { HOME: home },
      sendToDaemon: async (req) => {
        calls.push(req);
        if (req.command === 'lease_heartbeat') {
          return {
            ok: true,
            data: {
              lease: {
                leaseId: 'lease-demo-001',
                tenantId: 'micha-pierzcha-a',
                runId: 'demo-run-001',
                backend: 'android-instance',
              },
            },
          };
        }
        return {
          ok: true,
          data: {
            launchTarget: 'com.example.demo',
            packageName: 'com.example.demo',
          },
        };
      },
    },
  );

  assert.equal(result.code, null);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.success, true);
  assert.equal(payload.data.launchTarget, 'com.example.demo');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.command, 'lease_heartbeat');
  assert.equal(calls[1]?.meta?.tenantId, 'micha-pierzcha-a');
  assert.equal(calls[1]?.meta?.runId, 'demo-run-001');
  assert.equal(calls[1]?.meta?.leaseId, 'lease-demo-001');
  assert.equal(calls[1]?.flags?.tenant, 'micha-pierzcha-a');
  assert.equal(calls[1]?.flags?.runId, 'demo-run-001');
  assert.equal(calls[1]?.flags?.leaseId, 'lease-demo-001');
  assert.deepEqual(calls[1]?.positionals, []);

  fs.rmSync(root, { recursive: true, force: true });
});

test('minimal remote connect defers lease allocation until a platform-bound command runs', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = path.join(project, 'agent-device.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: 'http://remote-mac.example.test:9124/agent-device',
      tenant: 'acme',
      sessionIsolation: 'tenant',
      runId: 'run-123',
      platform: 'android',
    }),
    'utf8',
  );

  const connectResult = await runCliCapture(
    ['connect', '--remote-config', remoteConfig, '--state-dir', stateDir, '--json'],
    {
      cwd: project,
      env: { HOME: home },
    },
  );

  assert.equal(connectResult.code, null);
  assert.equal(connectResult.calls.length, 0);
  const connected = readActiveConnectionState({ stateDir });
  assert.match(connected?.session ?? '', /^adc-[a-z0-9]+$/);
  assert.equal(connected?.leaseId, undefined);
  assert.equal(connected?.leaseBackend, 'android-instance');

  const calls: CapturedDaemonRequest[] = [];
  const appsResult = await runCliCapture(['apps', '--state-dir', stateDir, '--json'], {
    cwd: project,
    env: { HOME: home },
    sendToDaemon: async (req) => {
      calls.push(req);
      if (req.command === 'lease_allocate') {
        return {
          ok: true,
          data: {
            lease: {
              leaseId: 'lease-123',
              tenantId: 'acme',
              runId: 'run-123',
              backend: 'android-instance',
            },
          },
        };
      }
      if (req.command === 'apps') {
        return {
          ok: true,
          data: {
            apps: ['com.example.demo'],
          },
        };
      }
      throw new Error(`unexpected daemon command: ${req.command}`);
    },
  });

  assert.equal(appsResult.code, null);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.command, 'lease_allocate');
  assert.equal(calls[0]?.meta?.tenantId, 'acme');
  assert.equal(calls[0]?.meta?.runId, 'run-123');
  assert.equal(calls[0]?.meta?.leaseBackend, 'android-instance');
  assert.equal(calls[1]?.command, 'apps');
  assert.equal(calls[1]?.flags?.leaseId, 'lease-123');
  assert.equal(calls[1]?.meta?.leaseId, 'lease-123');
  assert.equal(calls[1]?.flags?.platform, 'android');
  assert.equal(readActiveConnectionState({ stateDir })?.leaseId, 'lease-123');

  fs.rmSync(root, { recursive: true, force: true });
});

test('missing explicit remote config path returns parse error before daemon dispatch', async () => {
  const { root, home, project } = makeTempWorkspace();

  const result = await runCliCapture(['connect', '--remote-config', './missing.remote.json'], {
    cwd: project,
    env: { HOME: home },
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Remote config file not found/);
  assert.equal(result.calls.length, 0);

  fs.rmSync(root, { recursive: true, force: true });
});

test('connection status with remote config stays local without cloud auth', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = path.join(project, 'agent-device.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: 'https://bridge.agent-device.dev',
      tenant: 'acme',
      runId: 'run-123',
    }),
    'utf8',
  );

  const result = await runCliCapture(
    ['connection', 'status', '--remote-config', remoteConfig, '--state-dir', stateDir, '--json'],
    {
      cwd: project,
      env: { HOME: home, CI: 'true' },
      sendToDaemon: async () => {
        throw new Error('connection status should not contact daemon or cloud auth');
      },
    },
  );

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /"connected": false/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('normal commands accept direct remote-config usage', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = path.join(project, 'agent-device.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: 'http://remote-mac.example.test:9124/agent-device',
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
    }),
    'utf8',
  );

  const result = await runCliCapture(
    ['snapshot', '--remote-config', remoteConfig, '--state-dir', stateDir, '--json'],
    {
      cwd: project,
      env: { HOME: home },
      sendToDaemon: async (req) => {
        if (req.command === 'lease_allocate') {
          return {
            ok: true,
            data: {
              lease: {
                leaseId: 'lease-direct-001',
                tenantId: 'acme',
                runId: 'run-123',
                backend: 'android-instance',
              },
            },
          };
        }
        return { ok: true, data: { nodes: [], truncated: false } };
      },
    },
  );

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0]?.command, 'lease_allocate');
  assert.equal(result.calls[1]?.command, 'snapshot');
  assert.equal(
    result.calls[1]?.flags?.daemonBaseUrl,
    'http://remote-mac.example.test:9124/agent-device',
  );
  assert.equal(result.calls[1]?.meta?.tenantId, 'acme');
  assert.equal(result.calls[1]?.meta?.leaseId, 'lease-direct-001');
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'default' })?.leaseId,
    'lease-direct-001',
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test('remote-config commands reuse active generated session when profile has no session', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConnectionsDir = path.join(stateDir, 'remote-connections');
  fs.mkdirSync(remoteConnectionsDir, { recursive: true });
  const remoteConfig = path.join(project, 'agent-device.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: 'http://remote-mac.example.test:9124/agent-device',
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
    }),
    'utf8',
  );
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(remoteConnectionsDir, 'adc-generated.json'),
    JSON.stringify({
      version: 1,
      session: 'adc-generated',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: hashRemoteConfigFile(remoteConfig),
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-generated-001',
      leaseBackend: 'android-instance',
      platform: 'android',
      connectedAt: now,
      updatedAt: now,
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(remoteConnectionsDir, '.active-session.json'),
    JSON.stringify({ session: 'adc-generated' }),
    'utf8',
  );

  const result = await runCliCapture(
    ['snapshot', '--remote-config', remoteConfig, '--state-dir', stateDir, '--json'],
    {
      cwd: project,
      env: { HOME: home },
      sendToDaemon: async (req) => {
        if (req.command === 'lease_allocate') {
          throw new Error('should reuse the active generated lease');
        }
        if (req.command === 'lease_heartbeat') {
          return {
            ok: true,
            data: {
              lease: {
                leaseId: 'lease-generated-001',
                tenantId: 'acme',
                runId: 'run-123',
                backend: 'android-instance',
              },
            },
          };
        }
        return { ok: true, data: { nodes: [], truncated: false } };
      },
    },
  );

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0]?.command, 'lease_heartbeat');
  assert.equal(result.calls[1]?.command, 'snapshot');
  assert.equal(result.calls[1]?.session, 'adc-generated');
  assert.equal(result.calls[1]?.meta?.leaseId, 'lease-generated-001');

  fs.rmSync(root, { recursive: true, force: true });
});

test('remote-config commands keep profile session over active generated session', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConnectionsDir = path.join(stateDir, 'remote-connections');
  fs.mkdirSync(remoteConnectionsDir, { recursive: true });
  const remoteConfig = path.join(project, 'agent-device.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: 'http://remote-mac.example.test:9124/agent-device',
      tenant: 'acme',
      runId: 'run-profile',
      session: 'profile-session',
      platform: 'android',
    }),
    'utf8',
  );
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(remoteConnectionsDir, 'adc-generated.json'),
    JSON.stringify({
      version: 1,
      session: 'adc-generated',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: hashRemoteConfigFile(remoteConfig),
      tenant: 'acme',
      runId: 'run-active',
      leaseId: 'lease-generated-001',
      leaseBackend: 'android-instance',
      platform: 'android',
      connectedAt: now,
      updatedAt: now,
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(remoteConnectionsDir, '.active-session.json'),
    JSON.stringify({ session: 'adc-generated' }),
    'utf8',
  );

  const result = await runCliCapture(
    ['snapshot', '--remote-config', remoteConfig, '--state-dir', stateDir, '--json'],
    {
      cwd: project,
      env: { HOME: home },
      sendToDaemon: async (req) => {
        if (req.command === 'lease_heartbeat') {
          throw new Error('should not reuse the active generated lease');
        }
        if (req.command === 'lease_allocate') {
          return {
            ok: true,
            data: {
              lease: {
                leaseId: 'lease-profile-001',
                tenantId: 'acme',
                runId: 'run-profile',
                backend: 'android-instance',
              },
            },
          };
        }
        return { ok: true, data: { nodes: [], truncated: false } };
      },
    },
  );

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0]?.command, 'lease_allocate');
  assert.equal(result.calls[1]?.command, 'snapshot');
  assert.equal(result.calls[1]?.session, 'profile-session');
  assert.equal(result.calls[1]?.meta?.leaseId, 'lease-profile-001');

  fs.rmSync(root, { recursive: true, force: true });
});

test('devices allocates a pending remote lease before listing devices', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = path.join(project, 'agent-device.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: 'http://remote-mac.example.test:9124/agent-device',
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
    }),
    'utf8',
  );

  const connectResult = await runCliCapture(
    ['connect', '--remote-config', remoteConfig, '--state-dir', stateDir, '--json'],
    { cwd: project, env: { HOME: home } },
  );
  assert.equal(connectResult.code, null);

  const result = await runCliCapture(['devices', '--state-dir', stateDir, '--json'], {
    cwd: project,
    env: { HOME: home },
    sendToDaemon: async (req) => {
      if (req.command === 'lease_allocate') {
        return {
          ok: true,
          data: {
            lease: {
              leaseId: 'lease-devices-001',
              tenantId: 'acme',
              runId: 'run-123',
              backend: 'android-instance',
            },
          },
        };
      }
      if (req.command === 'devices') {
        return {
          ok: true,
          data: {
            devices: [
              {
                id: 'emulator-5554',
                name: 'Pixel 8',
                platform: 'android',
                kind: 'emulator',
                booted: true,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected daemon command: ${req.command}`);
    },
  });

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0]?.command, 'lease_allocate');
  assert.equal(result.calls[1]?.command, 'devices');
  assert.equal(result.calls[1]?.flags?.leaseId, 'lease-devices-001');
  assert.equal(result.calls[1]?.meta?.leaseId, 'lease-devices-001');

  fs.rmSync(root, { recursive: true, force: true });
});

test('direct remote-config command does not fall back to unrelated active session', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = path.join(project, 'agent-device.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: 'http://remote-mac.example.test:9124/agent-device',
      tenant: 'acme',
      runId: 'run-profile',
      session: 'profile-session',
      platform: 'android',
    }),
    'utf8',
  );
  fs.mkdirSync(path.join(stateDir, 'remote-connections'), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(stateDir, 'remote-connections', 'active-session.json'),
    JSON.stringify({
      version: 1,
      session: 'active-session',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: hashRemoteConfigFile(remoteConfig),
      tenant: 'acme',
      runId: 'run-active',
      leaseId: 'lease-active',
      leaseBackend: 'android-instance',
      platform: 'android',
      connectedAt: now,
      updatedAt: now,
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(stateDir, 'remote-connections', '.active-session.json'),
    JSON.stringify({ session: 'active-session' }),
    'utf8',
  );

  const result = await runCliCapture(
    ['snapshot', '--remote-config', remoteConfig, '--state-dir', stateDir, '--json'],
    {
      cwd: project,
      env: { HOME: home },
      sendToDaemon: async (req) => {
        if (req.command === 'lease_heartbeat') {
          throw new Error('should not reuse active-session lease');
        }
        if (req.command === 'lease_allocate') {
          return {
            ok: true,
            data: {
              lease: {
                leaseId: 'lease-profile',
                tenantId: 'acme',
                runId: 'run-profile',
                backend: 'android-instance',
              },
            },
          };
        }
        return { ok: true, data: { nodes: [], truncated: false } };
      },
    },
  );

  assert.equal(result.code, null);
  assert.equal(result.calls[0]?.command, 'lease_allocate');
  assert.equal(result.calls[1]?.command, 'snapshot');
  assert.equal(result.calls[1]?.session, 'profile-session');
  assert.equal(result.calls[1]?.meta?.runId, 'run-profile');
  assert.equal(result.calls[1]?.meta?.leaseId, 'lease-profile');
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'profile-session' })?.leaseId,
    'lease-profile',
  );
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'active-session' })?.leaseId,
    'lease-active',
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test('install-from-source --remote-config writes and reuses lease state', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = path.join(project, 'agent-device.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: 'http://remote-mac.example.test:9124/agent-device',
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
    }),
    'utf8',
  );

  const first = await runCliCapture(
    [
      'install-from-source',
      'https://example.com/app.apk',
      '--remote-config',
      remoteConfig,
      '--state-dir',
      stateDir,
      '--json',
    ],
    {
      cwd: project,
      env: { HOME: home },
      sendToDaemon: async (req) => {
        if (req.command === 'lease_allocate') {
          return {
            ok: true,
            data: {
              lease: {
                leaseId: 'lease-install-source-001',
                tenantId: 'acme',
                runId: 'run-123',
                backend: 'android-instance',
              },
            },
          };
        }
        return {
          ok: true,
          data: {
            launchTarget: 'com.example.demo',
            packageName: 'com.example.demo',
          },
        };
      },
    },
  );

  assert.equal(first.code, null);
  assert.equal(first.calls.length, 2);
  assert.equal(first.calls[0]?.command, 'lease_allocate');
  assert.equal(first.calls[1]?.command, 'install_source');
  assert.equal(first.calls[1]?.meta?.leaseId, 'lease-install-source-001');
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'default' })?.leaseId,
    'lease-install-source-001',
  );

  const second = await runCliCapture(
    [
      'install-from-source',
      'https://example.com/app.apk',
      '--remote-config',
      remoteConfig,
      '--state-dir',
      stateDir,
      '--json',
    ],
    {
      cwd: project,
      env: { HOME: home },
      sendToDaemon: async (req) => {
        if (req.command === 'lease_heartbeat') {
          return {
            ok: true,
            data: {
              lease: {
                leaseId: 'lease-install-source-001',
                tenantId: 'acme',
                runId: 'run-123',
                backend: 'android-instance',
              },
            },
          };
        }
        return {
          ok: true,
          data: {
            launchTarget: 'com.example.demo',
            packageName: 'com.example.demo',
          },
        };
      },
    },
  );

  assert.equal(second.code, null);
  assert.equal(second.calls.length, 2);
  assert.equal(second.calls[0]?.command, 'lease_heartbeat');
  assert.equal(second.calls[1]?.command, 'install_source');
  assert.equal(second.calls[1]?.meta?.leaseId, 'lease-install-source-001');

  fs.rmSync(root, { recursive: true, force: true });
});

test('open warns when explicit remote flags bypass saved runtime hints', async () => {
  const { root, home, project } = makeTempWorkspace();

  const result = await runCliCapture(
    [
      'open',
      'com.example.demo',
      '--platform',
      'android',
      '--daemon-base-url',
      'http://remote-mac.example.test:9124/agent-device',
      '--tenant',
      'acme',
      '--run-id',
      'run-123',
      '--lease-id',
      'lease-123',
      '--json',
    ],
    {
      cwd: project,
      env: { HOME: home },
      sendToDaemon: async () => ({
        ok: true,
        data: {
          platform: 'android',
          target: 'mobile',
          device: 'Pixel',
          id: 'emulator-5554',
          appBundleId: 'com.example.demo',
        },
      }),
    },
  );

  assert.equal(result.code, null);
  assert.match(result.stderr, /without saved Metro runtime hints/);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.runtime, undefined);

  fs.rmSync(root, { recursive: true, force: true });
});

test('remote config hash drift blocks normal commands but not disconnect cleanup', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(stateDir, 'remote-connections'), { recursive: true });
  const remoteConfig = path.join(project, 'agent-device.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: 'http://remote-mac.example.test:9124/agent-device',
      platform: 'android',
    }),
    'utf8',
  );
  const originalHash = hashRemoteConfigFile(remoteConfig);
  fs.writeFileSync(
    path.join(stateDir, 'remote-connections', 'default.json'),
    JSON.stringify({
      version: 1,
      session: 'default',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: originalHash,
      daemon: {
        baseUrl: 'http://remote-mac.example.test:9124/agent-device',
        transport: 'http',
      },
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-123',
      leaseBackend: 'android-instance',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    'utf8',
  );
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: 'http://remote-mac.example.test:9124/agent-device',
      platform: 'android',
      metroPublicBaseUrl: 'http://127.0.0.1:8081',
    }),
    'utf8',
  );

  const blocked = await runCliCapture(['snapshot', '--state-dir', stateDir, '--json'], {
    cwd: project,
    env: { HOME: home },
  });
  assert.equal(blocked.code, 1);
  assert.match(blocked.stdout, /Active remote connection config changed/);

  const disconnected = await runCliCapture(['disconnect', '--state-dir', stateDir, '--json'], {
    cwd: project,
    env: { HOME: home },
  });
  assert.equal(disconnected.code, null);
  assert.equal(disconnected.calls.at(-1)?.command, 'lease_release');
  assert.equal(readRemoteConnectionState({ stateDir, session: 'default' }), null);

  fs.rmSync(root, { recursive: true, force: true });
});

test('disconnect cleans connection state when remote config file is gone', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(stateDir, 'remote-connections'), { recursive: true });
  const remoteConfig = path.join(project, 'agent-device.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: 'http://remote-mac.example.test:9124/agent-device',
      platform: 'android',
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(stateDir, 'remote-connections', 'default.json'),
    JSON.stringify({
      version: 1,
      session: 'default',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: hashRemoteConfigFile(remoteConfig),
      daemon: {
        baseUrl: 'http://remote-mac.example.test:9124/agent-device',
        transport: 'http',
      },
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-123',
      leaseBackend: 'android-instance',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    'utf8',
  );
  fs.rmSync(remoteConfig, { force: true });

  const disconnected = await runCliCapture(['disconnect', '--state-dir', stateDir, '--json'], {
    cwd: project,
    env: { HOME: home },
  });

  assert.equal(disconnected.code, null);
  assert.equal(disconnected.calls.at(-1)?.command, 'lease_release');
  assert.equal(
    disconnected.calls.at(-1)?.flags?.daemonBaseUrl,
    'http://remote-mac.example.test:9124/agent-device',
  );
  assert.equal(readRemoteConnectionState({ stateDir, session: 'default' }), null);

  fs.rmSync(root, { recursive: true, force: true });
});

test('disconnect removes malformed connection state', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const connectionsDir = path.join(stateDir, 'remote-connections');
  const statePath = path.join(connectionsDir, 'default.json');
  const activePath = path.join(connectionsDir, '.active-session.json');
  fs.mkdirSync(connectionsDir, { recursive: true });
  fs.writeFileSync(statePath, '{not json', 'utf8');
  fs.writeFileSync(activePath, JSON.stringify({ session: 'default' }), 'utf8');

  const disconnected = await runCliCapture(['disconnect', '--state-dir', stateDir, '--json'], {
    cwd: project,
    env: { HOME: home },
  });

  assert.equal(disconnected.code, null);
  assert.equal(disconnected.calls.length, 0);
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(fs.existsSync(activePath), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('config and env defaults include session lock policy flags', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.mkdirSync(path.join(home, '.agent-device'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({ sessionLock: 'reject' }),
    'utf8',
  );

  const result = await runCliCapture(['snapshot', '--json'], {
    cwd: project,
    env: { HOME: home, AGENT_DEVICE_SESSION_LOCK: 'strip' },
  });

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.meta?.lockPolicy, 'strip');
  assert.equal(Object.hasOwn(result.calls[0]?.flags ?? {}, 'sessionLock'), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('config defaults drive bound-session metadata without env-only fallbacks', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({ session: 'qa-ios', platform: 'ios', sessionLock: 'reject' }),
    'utf8',
  );

  const result = await runCliCapture(['snapshot', '--json'], {
    cwd: project,
    env: { HOME: home },
  });

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.session, 'qa-ios');
  assert.equal(result.calls[0]?.flags?.platform, 'ios');
  assert.equal(result.calls[0]?.meta?.lockPolicy, 'reject');
  assert.equal(result.calls[0]?.meta?.lockPlatform, 'ios');

  fs.rmSync(root, { recursive: true, force: true });
});

test('missing explicit config path returns parse error before daemon dispatch', async () => {
  const { root, home, project } = makeTempWorkspace();

  const result = await runCliCapture(['devices', '--config', './missing.json'], {
    cwd: project,
    env: { HOME: home },
  });

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /Config file not found/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('invalid config key returns parse error before daemon dispatch', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({ notARealFlag: true }),
    'utf8',
  );

  const result = await runCliCapture(['devices'], {
    cwd: project,
    env: { HOME: home },
  });

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /Unknown config key "notARealFlag"/);

  fs.rmSync(root, { recursive: true, force: true });
});
