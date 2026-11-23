import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { makeTempWorkspace, pluginHome, pluginSource, selectPlugin } from '@agent-device/test-kit';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { runCliCapture } from '../../__tests__/cli-capture.ts';
import { writeCliSession } from '../auth-session.ts';
import { CLI_SESSION_FORMAT_VERSION } from '../cli-session-format.ts';

const SESSION = 'ci';
const DAEMON_A = 'https://bridge.agent-device.dev/a';
const DAEMON_B = 'https://bridge.agent-device.dev/b';
const ACCESS_TOKEN = 'adc_live_fixture_access';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function connectProfile({
  daemonB,
  profileDaemonA,
  reconnect = true,
}: {
  daemonB?: string;
  profileDaemonA?: string;
  reconnect?: boolean;
}) {
  const { root, home, project } = makeTempWorkspace();
  const stateDirA = path.join(root, 'state-a');
  const stateDirB = path.join(root, 'state-b');
  const profilePath = path.join(project, 'remote.json');
  const installed = pluginHome();
  selectPlugin(
    installed.home,
    '@agent-device/limrun',
    pluginSource('limrun', {
      extra: `connection: {
        capabilities: {
          leaseKind: 'direct-device-provider',
          requiresRemoteDaemon: false,
          requiresAppAttachment: false,
          supportsArtifacts: false,
          supportsDeferredAppSelection: true,
          supportsDirectPortReverse: false,
          usesCloudWebDriverLease: false,
        },
        resolve() {},
        verify: async () => ({ service: 'Limrun', status: 'verified', verificationMessage: 'Verified' }),
      },`,
    }),
  );
  const baseProfile = {
    stateDir: stateDirB,
    platform: 'android',
    leaseBackend: 'android-instance',
  };
  const connect = ['connect', '--session', SESSION, '--remote-config', profilePath, '--json'];
  fs.writeFileSync(
    profilePath,
    JSON.stringify({
      ...baseProfile,
      daemonBaseUrl: daemonB,
      tenant: 'tenant-b',
      runId: 'run-b',
      leaseProvider: 'limrun',
    }),
  );
  const first = await runCliCapture(connect, {
    cwd: project,
    env: { HOME: home, ...installed.env, AGENT_DEVICE_DAEMON_AUTH_TOKEN: ACCESS_TOKEN },
  });
  assert.equal(first.code, null, first.stdout + first.stderr);
  const stateB = readRemoteConnectionState({ stateDir: stateDirB, session: SESSION });
  assert.equal(stateB?.leaseProvider, 'limrun');

  if (reconnect) {
    fs.writeFileSync(
      profilePath,
      JSON.stringify({
        ...baseProfile,
        daemonBaseUrl: profileDaemonA,
        tenant: 'tenant-a',
        runId: 'run-a',
        leaseProvider: 'cloud',
      }),
    );
    const second = await runCliCapture(
      [...connect, '--state-dir', stateDirA, '--daemon-base-url', DAEMON_A],
      {
        cwd: project,
        env: { HOME: home, AGENT_DEVICE_DAEMON_AUTH_TOKEN: ACCESS_TOKEN },
      },
    );
    assert.equal(second.code, null, second.stdout + second.stderr);
    assert.equal(
      readRemoteConnectionState({ stateDir: stateDirA, session: SESSION })?.leaseProvider,
      'cloud',
    );
  }
  return { home, project, stateDirA, stateDirB, stateB };
}

test('the redirected record supplies authentication and materialization after the profile is edited', async () => {
  const { home, project, stateDirA, stateDirB, stateB } = await connectProfile({
    daemonB: DAEMON_B,
  });
  writeCliSession({
    stateDir: stateDirB,
    session: {
      version: CLI_SESSION_FORMAT_VERSION,
      id: 'auth-b',
      cloudBaseUrl: 'https://bridge.agent-device.dev',
      refreshCredential: 'adc_refresh_b',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  });
  const refresh = vi.fn(async (_url: unknown, init: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init.body)), {
      refreshCredential: 'adc_refresh_b',
      acceptsRotatedRefreshCredential: true,
      daemonBaseUrl: DAEMON_B,
      tenant: 'tenant-b',
      runId: stateB.runId,
      session: SESSION,
    });
    return Response.json({ accessToken: ACCESS_TOKEN });
  });
  vi.stubGlobal('fetch', refresh);

  const result = await runCliCapture(['snapshot', '--session', SESSION, '--json'], {
    cwd: project,
    env: { HOME: home, AGENT_DEVICE_STATE_DIR: stateDirA },
    sendToDaemon: async (request) =>
      request.command === 'lease_allocate'
        ? {
            ok: true,
            data: {
              lease: {
                leaseId: 'lease-b',
                tenantId: 'tenant-b',
                runId: stateB.runId,
                backend: 'android-instance',
                leaseProvider: 'limrun',
              },
            },
          }
        : { ok: true, data: { nodes: [], truncated: false } },
  });
  assert.equal(result.code, null, result.stdout + result.stderr);
  assert.equal(refresh.mock.calls.length, 1);
  assert.deepEqual(
    result.calls.map((call) => call.command),
    ['lease_allocate', 'snapshot'],
  );
  for (const call of result.calls) {
    assert.equal(call.meta?.tenantId, 'tenant-b');
    assert.equal(call.meta?.runId, stateB.runId);
    assert.equal(call.meta?.leaseProvider, 'limrun');
    assert.equal(call.flags?.daemonBaseUrl, DAEMON_B);
    assert.equal(call.flags?.stateDir, stateDirB);
  }
  for (const transport of result.transportOptions) {
    assert.equal(transport?.authToken, ACCESS_TOKEN);
  }
  assert.equal(
    readRemoteConnectionState({ stateDir: stateDirB, session: SESSION })?.leaseId,
    'lease-b',
  );
  assert.equal(
    readRemoteConnectionState({ stateDir: stateDirA, session: SESSION })?.leaseId,
    undefined,
  );
});

test.each([undefined, DAEMON_A])(
  'a missing plugin for the redirected local record refuses before authentication (profile URL: %s)',
  async (profileDaemonA) => {
    const { home, project, stateDirA } = await connectProfile({ profileDaemonA });
    const result = await runCliCapture(['apps', '--session', SESSION, '--json'], {
      cwd: project,
      env: { HOME: home, AGENT_DEVICE_STATE_DIR: stateDirA },
    });
    assert.equal(result.code, 1, result.stdout + result.stderr);
    const { error } = JSON.parse(result.stdout);
    assert.equal(error.details?.reason, 'plugin-not-installed');
    assert.equal(error.details?.provider, 'limrun');
    assert.match(error.details?.installCommand, /^agent-device plugins add @agent-device\/limrun/);
    assert.deepEqual(result.calls, []);
  },
);

test('explicit daemon flags override a redirected local connection', async () => {
  const { home, project, stateDirA } = await connectProfile({ profileDaemonA: DAEMON_A });
  const result = await runCliCapture(
    [
      'apps',
      '--session',
      SESSION,
      '--daemon-base-url',
      DAEMON_B,
      '--daemon-auth-token',
      ACCESS_TOKEN,
      '--json',
    ],
    {
      cwd: project,
      env: { HOME: home, AGENT_DEVICE_STATE_DIR: stateDirA },
      defaultResponse: { ok: true, data: { apps: [] } },
    },
  );
  assert.equal(result.code, null, result.stdout + result.stderr);
  assert.equal(result.calls[0]?.flags?.daemonBaseUrl, DAEMON_B);
  assert.equal(result.transportOptions[0]?.authToken, ACCESS_TOKEN);
});

test('materialization reuses the record read from the state-directory default', async () => {
  const { home, project, stateDirB } = await connectProfile({
    daemonB: DAEMON_B,
    reconnect: false,
  });
  const recordPath = path.join(stateDirB, 'remote-connections', `${SESSION}.json`);
  const readFile = vi.spyOn(fs, 'readFileSync');
  const result = await runCliCapture(['apps', '--session', SESSION, '--json'], {
    cwd: project,
    env: {
      HOME: home,
      AGENT_DEVICE_STATE_DIR: stateDirB,
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: ACCESS_TOKEN,
    },
    defaultResponse: { ok: true, data: { apps: [] } },
  });
  assert.equal(result.code, null, result.stdout + result.stderr);
  assert.equal(readFile.mock.calls.filter(([file]) => file === recordPath).length, 1);
});
