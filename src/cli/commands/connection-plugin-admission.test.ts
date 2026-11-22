import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { runCli } from '../../cli.ts';
import { runCliCapture } from '../../__tests__/cli-capture.ts';
import {
  hashRemoteConfigFile,
  readRemoteConnectionState,
  writeRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { beginStdoutCapture, pluginHome, selectPlugin, pluginSource } from '@agent-device/test-kit';

const provider = 'browserstack';
const packageName = '@agent-device/browserstack';
const capabilities = {
  leaseKind: 'direct-device-provider',
  requiresAppAttachment: false,
  requiresRemoteDaemon: false,
  supportsArtifacts: false,
  supportsDeferredAppSelection: false,
  supportsDirectPortReverse: false,
  usesCloudWebDriverLease: true,
};

afterEach(() => vi.unstubAllEnvs());

function fixture(home: string, leaseProvider = provider, daemonBaseUrl?: string) {
  const stateDir = path.join(home, 'state');
  const remoteConfigPath = path.join(home, 'remote.json');
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      tenant: 'team',
      runId: 'run-1',
      leaseProvider,
      leaseBackend: 'android-instance',
      platform: 'android',
      daemonBaseUrl,
    }),
  );
  return { stateDir, remoteConfigPath };
}

function seedState(f: ReturnType<typeof fixture>, leaseProvider = provider) {
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir: f.stateDir,
    state: {
      version: 1,
      session: 'default',
      remoteConfigPath: f.remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(f.remoteConfigPath),
      tenant: 'team',
      runId: 'run-1',
      leaseProvider,
      leaseBackend: 'android-instance',
      platform: 'android',
      connectedAt: now,
      updatedAt: now,
    },
  });
}

test.each(['missing', 'failed'] as const)(
  'routed %s vetted plugin fails before capability-based actions',
  async (kind) => {
    const { home, env } = pluginHome();
    if (kind === 'failed')
      selectPlugin(home, packageName, 'throw new Error("registration failed")');
    const f = fixture(home);
    const opts = { cwd: home, env: { ...env, AGENT_DEVICE_SESSION: 'default' } };
    const expected = kind === 'missing' ? 'plugin-not-installed' : 'plugin-unavailable';
    const connect = await runCliCapture(
      ['connect', '--remote-config', f.remoteConfigPath, '--state-dir', f.stateDir, '--json'],
      opts,
    );
    seedState(f);
    const status = await runCliCapture(
      ['connection', 'status', '--state-dir', f.stateDir, '--json'],
      opts,
    );
    const snapshot = await runCliCapture(
      ['snapshot', '--remote-config', f.remoteConfigPath, '--state-dir', f.stateDir, '--json'],
      opts,
    );
    const disconnected = await runCliCapture(
      ['disconnect', '--state-dir', f.stateDir, '--json'],
      opts,
    );
    assert.equal(disconnected.code, null);
    assert.equal(readRemoteConnectionState({ stateDir: f.stateDir, session: 'default' }), null);
    assert.equal(status.code, null, status.stdout);
    assert.deepEqual(status.calls, []);
    for (const result of [connect, snapshot]) {
      const parsed = JSON.parse(result.stdout);
      assert.equal(result.code, 1, result.stdout);
      assert.equal(parsed.error?.code, 'UNSUPPORTED_OPERATION', result.stdout);
      assert.equal(parsed.error?.details?.reason, expected, result.stdout);
      assert.deepEqual(result.calls, []);
      assert.doesNotMatch(result.stdout, /install-from-source|leaseId.*pending/);
    }
  },
);

test('a generic remote profile remains connectable without a plugin', async () => {
  const { home, env } = pluginHome();
  const f = fixture(home, 'ordinary-remote', 'https://daemon.example.test');
  const result = await runCliCapture(
    ['connect', '--remote-config', f.remoteConfigPath, '--state-dir', f.stateDir, '--json'],
    { cwd: home, env: { ...env, AGENT_DEVICE_SESSION: 'default' } },
  );
  assert.equal(result.code, null);
  assert.equal(
    readRemoteConnectionState({ stateDir: f.stateDir, session: 'default' })?.leaseProvider,
    'ordinary-remote',
  );
});

test('routed status uses capabilities from the supplied host store rather than the process store', async () => {
  const { home } = pluginHome();
  const ambient = pluginHome();
  vi.stubEnv('AGENT_DEVICE_HOME', ambient.home);
  selectPlugin(
    home,
    packageName,
    pluginSource(provider, {
      extra: `connection: { capabilities: ${JSON.stringify(capabilities)}, resolve() {}, verify() { return { provider: 'browserstack', service: 'BrowserStack', verificationMessage: 'verified' }; } },`,
    }),
  );
  const f = fixture(home, ' browserstack ');
  const capture = beginStdoutCapture();
  const sendToDaemon = vi.fn(async () => {
    throw new Error('unexpected daemon access');
  });
  try {
    const suppliedHost = {
      cwd: home,
      env: {
        AGENT_DEVICE_HOME: home,
        AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
        AGENT_DEVICE_SESSION: 'default',
      },
    };
    await runCli(
      ['connect', '--remote-config', f.remoteConfigPath, '--state-dir', f.stateDir],
      { sendToDaemon },
      suppliedHost,
    );
    const statePath = path.join(f.stateDir, 'remote-connections', 'default.json');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).leaseProvider, provider);
    assert.match(capture.read(), /BrowserStack/);
    const statusOutputStart = capture.read().length;
    await runCli(
      ['connection', 'status', '--state-dir', f.stateDir],
      { sendToDaemon },
      suppliedHost,
    );
    const statusOutput = capture.read().slice(statusOutputStart);
    assert.match(statusOutput, /The first device command shown below will allocate one/);
    assert.doesNotMatch(statusOutput, /install-from-source/);
    assert.equal(sendToDaemon.mock.calls.length, 0);
  } finally {
    capture.restore();
  }
});

test.each(['missing', 'local verifier'] as const)(
  'a remote profile with a %s client plugin connects and keeps status readable',
  async (plugin) => {
    const { home, env } = pluginHome();
    if (plugin === 'local verifier') {
      selectPlugin(
        home,
        packageName,
        pluginSource(provider, {
          extra: `connection: { capabilities: ${JSON.stringify(capabilities)}, resolve() {}, verify() { throw new Error('client verification requires credentials'); } },`,
        }),
      );
    }
    const f = fixture(home, ' browserstack ', 'https://daemon.example.test');
    const opts = { cwd: home, env: { ...env, AGENT_DEVICE_SESSION: 'default' } };
    const connect = await runCliCapture(
      ['connect', '--remote-config', f.remoteConfigPath, '--state-dir', f.stateDir, '--json'],
      opts,
    );
    assert.equal(connect.code, null, connect.stdout + connect.stderr);
    const record = path.join(f.stateDir, 'remote-connections', 'default.json');
    const saved = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.equal(saved.leaseProvider, provider);
    fs.writeFileSync(record, JSON.stringify({ ...saved, leaseProvider: ' browserstack ' }));
    const status = await runCliCapture(
      ['connection', 'status', '--state-dir', f.stateDir, '--json'],
      opts,
    );
    assert.equal(status.code, null, status.stdout + status.stderr);
    assert.equal(JSON.parse(status.stdout).data.leaseProvider, provider);
    assert.deepEqual(status.calls, []);
  },
);

test('connect verifies and saves a registry provider id longer than a daemon lease label', async () => {
  const { home, env } = pluginHome();
  const longProvider = 'provider-' + 'x'.repeat(64);
  selectPlugin(
    home,
    packageName,
    pluginSource(longProvider, {
      extra: `connection: { capabilities: ${JSON.stringify(capabilities)}, resolve() {}, verify() { return { provider: '${longProvider}', service: 'Long provider', verificationMessage: 'verified' }; } },`,
    }),
  );
  const f = fixture(home, ` ${longProvider} `);
  const result = await runCliCapture(
    ['connect', '--remote-config', f.remoteConfigPath, '--state-dir', f.stateDir, '--json'],
    { cwd: home, env: { ...env, AGENT_DEVICE_SESSION: 'default' } },
  );
  assert.equal(result.code, null, result.stdout + result.stderr);
  assert.equal(
    readRemoteConnectionState({ stateDir: f.stateDir, session: 'default' })?.leaseProvider,
    longProvider,
  );
});
