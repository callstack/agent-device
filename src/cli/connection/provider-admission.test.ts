import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  hashRemoteConfigFile,
  readActiveConnectionState,
  readRemoteConnectionState,
  writeRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { makeTempWorkspace } from '@agent-device/test-kit';
import { runCliCapture } from '../../__tests__/cli-capture.ts';
import { resolveCloudAccessForConnect, resolveRemoteAuthForCli } from '../auth-session.ts';

// No plugin is installed in this file. Authentication is the seam: a refusal that precedes it never
// calls it, so no login starts and no auth state is written.
vi.mock('../auth-session.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth-session.ts')>()),
  resolveRemoteAuthForCli: vi.fn(async (options: { flags: unknown }) => ({
    flags: options.flags,
    source: 'none',
  })),
  resolveCloudAccessForConnect: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const CLOUD_DAEMON = 'https://bridge.agent-device.dev/agent-device';

/** Every file under `directory` with its content, so a test can assert that nothing was written. */
function snapshotTree(directory: string): Record<string, string> {
  if (!fs.existsSync(directory)) return {};
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(directory, file)] = fs.readFileSync(file, 'utf8');
  }
  return files;
}

function limrunProfile(project: string): string {
  const remoteConfig = path.join(project, 'limrun.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: CLOUD_DAEMON,
      tenant: 'team-a',
      runId: 'run-a',
      leaseProvider: 'limrun',
      leaseBackend: 'android-instance',
      platform: 'android',
    }),
  );
  return remoteConfig;
}

function assertLimrunPluginMissing(stdout: string): void {
  const { error } = JSON.parse(stdout);
  assert.equal(error.code, 'UNSUPPORTED_OPERATION');
  assert.equal(error.details.reason, 'plugin-not-installed');
  assert.equal(error.details.package, '@agent-device/limrun');
  assert.match(error.details.installCommand, /agent-device plugins add @agent-device\/limrun/);
}

test.each([
  { route: 'non-interactive', extra: ['--no-login'] },
  { route: 'interactive', extra: [] },
])(
  'connect --remote-config with a Limrun profile refuses the missing plugin before $route authentication',
  async ({ extra }) => {
    const { root, home, project } = makeTempWorkspace();
    const stateDir = path.join(root, 'state');
    const remoteConfig = limrunProfile(project);

    const result = await runCliCapture(
      ['connect', '--remote-config', remoteConfig, '--session', 'ci', ...extra, '--json'],
      { cwd: project, env: { HOME: home, AGENT_DEVICE_STATE_DIR: stateDir } },
    );

    assert.equal(result.code, 1);
    assertLimrunPluginMissing(result.stdout);
    assert.equal(vi.mocked(resolveRemoteAuthForCli).mock.calls.length, 0);
    assert.equal(result.calls.length, 0);
    assert.deepEqual(snapshotTree(path.join(stateDir, 'remote-connections')), {});
    assert.deepEqual(snapshotTree(path.join(stateDir, 'auth')), {});
    fs.rmSync(root, { recursive: true, force: true });
  },
);

function storedLimrunConnection() {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = limrunProfile(project);
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'limrun-a',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: hashRemoteConfigFile(remoteConfig),
      daemon: { baseUrl: CLOUD_DAEMON },
      tenant: 'team-a',
      runId: 'run-a',
      leaseBackend: 'android-instance',
      leaseProvider: 'limrun',
      platform: 'android',
      connectedAt: now,
      updatedAt: now,
    },
  });
  return { root, home, project, stateDir };
}

// The rule: this host needs the plugin only for a connection it drives itself. A connection whose
// daemon is configured elsewhere is answered by that daemon's own provider registration, so the
// command authenticates and dispatches.
test('a device command on a stored Limrun connection with a remote daemon dispatches without the plugin', async () => {
  const { root, home, project, stateDir } = storedLimrunConnection();
  const token = 'adc_live_remote_daemon_token_1348';

  const result = await runCliCapture(
    ['snapshot', '--session', 'limrun-a', '--state-dir', stateDir, '--json'],
    {
      cwd: project,
      env: { HOME: home, AGENT_DEVICE_DAEMON_AUTH_TOKEN: token },
      sendToDaemon: async (req) =>
        req.command === 'lease_heartbeat' || req.command === 'lease_allocate'
          ? {
              ok: true,
              data: {
                lease: {
                  leaseId: 'lease-limrun-a',
                  tenantId: 'team-a',
                  runId: 'run-a',
                  backend: 'android-instance',
                  leaseProvider: 'limrun',
                },
              },
            }
          : req.command === 'snapshot'
            ? { ok: true, data: { nodes: [], truncated: false } }
            : { ok: true, data: {} },
    },
  );

  assert.equal(result.code, null, result.stdout + result.stderr);
  assert.ok(vi.mocked(resolveRemoteAuthForCli).mock.calls.length > 0, 'auth must proceed');
  assert.deepEqual(
    result.calls.map((call) => call.command),
    ['lease_allocate', 'snapshot'],
  );
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.success, true, result.stdout);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an explicit Limrun remote config with a remote daemon dispatches without the plugin', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = limrunProfile(project);
  const token = 'adc_live_remote_daemon_token_1348';

  const result = await runCliCapture(
    [
      'snapshot',
      '--session',
      'ci',
      '--remote-config',
      remoteConfig,
      '--state-dir',
      stateDir,
      '--json',
    ],
    {
      cwd: project,
      env: { HOME: home, AGENT_DEVICE_DAEMON_AUTH_TOKEN: token },
      sendToDaemon: async (req) =>
        req.command === 'lease_allocate' || req.command === 'lease_heartbeat'
          ? {
              ok: true,
              data: {
                lease: {
                  leaseId: 'lease-ci',
                  tenantId: 'team-a',
                  runId: 'run-a',
                  backend: 'android-instance',
                  leaseProvider: 'limrun',
                },
              },
            }
          : { ok: true, data: {} },
    },
  );

  assert.equal(result.code, null, result.stdout + result.stderr);
  assert.ok(vi.mocked(resolveRemoteAuthForCli).mock.calls.length > 0, 'auth must proceed');
  assert.deepEqual(
    result.calls.map((call) => call.command),
    ['lease_allocate', 'snapshot'],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

// A connection with no daemon configured elsewhere is driven from this process, and only the plugin
// can drive it: that route still refuses before it authenticates or dispatches.
test('a stored Limrun connection with no configured daemon refuses the missing plugin before authentication', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = limrunProfile(project);
  const profile = JSON.parse(fs.readFileSync(remoteConfig, 'utf8')) as Record<string, unknown>;
  delete profile.daemonBaseUrl;
  fs.writeFileSync(remoteConfig, JSON.stringify(profile));
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'limrun-local',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: hashRemoteConfigFile(remoteConfig),
      tenant: 'team-a',
      runId: 'run-a',
      leaseBackend: 'android-instance',
      leaseProvider: 'limrun',
      platform: 'android',
      connectedAt: now,
      updatedAt: now,
    },
  });
  const before = snapshotTree(stateDir);

  const result = await runCliCapture(
    ['snapshot', '--session', 'limrun-local', '--state-dir', stateDir, '--json'],
    { cwd: project, env: { HOME: home } },
  );

  assert.equal(result.code, 1, result.stdout + result.stderr);
  assertLimrunPluginMissing(result.stdout);
  assert.equal(vi.mocked(resolveRemoteAuthForCli).mock.calls.length, 0);
  assert.equal(result.calls.length, 0);
  assert.deepEqual(snapshotTree(stateDir), before);
  fs.rmSync(root, { recursive: true, force: true });
});

test('disconnect stays outside provider admission after the plugin is removed', async () => {
  const { root, home, project, stateDir } = storedLimrunConnection();

  const result = await runCliCapture(
    ['disconnect', '--session', 'limrun-a', '--state-dir', stateDir, '--json'],
    { cwd: project, env: { HOME: home } },
  );

  assert.equal(result.code, null, result.stdout + result.stderr);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'limrun-a' }), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('connect cloud refuses a Limrun profile from the control plane before anything is written', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  // A providerless connection is active before the refused connect.
  const activeConfig = path.join(project, 'active.remote.json');
  fs.writeFileSync(activeConfig, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'active-b',
      remoteConfigPath: activeConfig,
      remoteConfigHash: hashRemoteConfigFile(activeConfig),
      tenant: 'team-b',
      runId: 'run-b',
      connectedAt: now,
      updatedAt: now,
    },
  });
  const before = snapshotTree(stateDir);
  vi.mocked(resolveCloudAccessForConnect).mockResolvedValue({
    accessToken: 'adc_agent_cloud',
    cloudBaseUrl: 'https://cloud.example',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            connection: {
              remoteConfigProfile: { tenant: 'acme', runId: 'run-1', leaseProvider: 'limrun' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ),
  );

  const result = await runCliCapture(
    ['connect', 'cloud', '--session', 'cloud-limrun', '--state-dir', stateDir, '--json'],
    { cwd: project, env: { HOME: home } },
  );

  assert.equal(result.code, 1);
  assertLimrunPluginMissing(result.stdout);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'cloud-limrun' }), null);
  assert.equal(readActiveConnectionState({ stateDir })?.session, 'active-b');
  assert.deepEqual(snapshotTree(stateDir), before);
  fs.rmSync(root, { recursive: true, force: true });
});
