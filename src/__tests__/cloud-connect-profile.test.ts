import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connectCommand } from '../cli/commands/connection.ts';
import { buildConnectClientId } from '../cli/connection/client-id.ts';
import { resolveCloudAccessForConnect } from '../cli/auth-session.ts';
import { runCliCapture } from './cli-capture.ts';
import {
  hashRemoteConfigFile,
  readActiveConnectionState,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import { normalizeError } from '@agent-device/kernel/errors';
import {
  mkdtempForTestSync,
  bindTestCommandHost,
  createTestHostEnvironment,
  beginStdoutCapture,
} from '@agent-device/test-kit';

vi.mock('@agent-device/plugins/store', async (importOriginal) =>
  (await import('./test-utils/limrun-plugin-store.ts')).storeWithLimrunInstalled(
    importOriginal as () => Promise<typeof import('@agent-device/plugins/store')>,
  ),
);

bindTestCommandHost();

// The Limrun SDK is the boundary this suite stubs: the provider's own connection verification is
// what `connect limrun` runs, and nothing here may reach the provider's API. Both routes in are
// answered — the account client's list, and the attached instance's client — and neither network.
const limrunSdk = vi.hoisted(() => {
  const accountClients: Array<Record<string, unknown>> = [];
  const attachedClients: Array<Record<string, unknown>> = [];
  return {
    accountClients,
    attachedClients,
    accountList: vi.fn(async () => ({ getPaginatedItems: () => [] })),
    connectAttached: vi.fn(async (options: Record<string, unknown>) => {
      attachedClients.push(options);
      return { disconnect: () => undefined };
    }),
  };
});

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly androidInstances = { list: limrunSdk.accountList };
    readonly iosInstances = { list: limrunSdk.accountList };

    constructor(options: Record<string, unknown>) {
      limrunSdk.accountClients.push(options);
    }
  },
}));

vi.mock('@limrun/api/ios-client', () => ({ createInstanceClient: limrunSdk.connectAttached }));
vi.mock('@limrun/api/instance-client', () => ({ createInstanceClient: limrunSdk.connectAttached }));

vi.mock('../cli/auth-session.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cli/auth-session.ts')>()),
  resolveCloudAccessForConnect: vi.fn(),
}));

afterEach(() => {
  limrunSdk.accountClients.length = 0;
  limrunSdk.attachedClients.length = 0;
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const mockedResolveCloudAccessForConnect = vi.mocked(resolveCloudAccessForConnect);

test('connect without remote config generates one from cloud connection profile', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-cloud-');
  const stateDir = path.join(tempRoot, '.state');
  const fetchMock = mockCloudConnectionProfile({
    remoteConfigProfile: {
      daemonBaseUrl: 'https://bridge.example.com/agent-device',
      daemonTransport: 'http',
      tenant: 'acme',
      runId: 'demo-run-001',
      sessionIsolation: 'tenant',
      metroKind: 'auto',
      metroPublicBaseUrl: 'http://127.0.0.1:8081',
      metroProxyBaseUrl: 'https://bridge.example.com',
    },
  });

  try {
    await connectWithGeneratedCloudProfile(stateDir);
    await connectWithGeneratedCloudProfile(stateDir);

    assertGeneratedProfileState(readRequiredActiveState(stateDir));
    assert.equal(
      fetchProfileUrl(fetchMock),
      'https://cloud.example/api/control-plane/connection-profile',
    );
    assert.equal(fetchMock.mock.calls.length, 2);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('cloud connect uses neutral public service wording in human and JSON output', async () => {
  const profile = {
    remoteConfigProfile: {
      daemonBaseUrl: 'https://bridge.example.com/agent-device',
      tenant: 'acme',
      runId: 'demo-run-001',
      leaseProvider: 'cloud',
    },
  };

  mockCloudConnectionProfile(profile);
  const human = await runCliCapture(['connect', '--session=ci'], {
    stateDirPrefix: 'agent-device-connect-cloud-wording-human-',
  });
  assert.match(human.stdout, /^Connected successfully with the configured cloud service\./);

  mockCloudConnectionProfile(profile);
  const json = await runCliCapture(['connect', '--session=ci', '--json'], {
    stateDirPrefix: 'agent-device-connect-cloud-wording-json-',
  });
  const data = (JSON.parse(json.stdout) as { data: { verification: { service: string } } }).data;
  assert.equal(data.verification.service, 'the configured cloud service');
});

test('connect limrun generates a local daemon remote profile', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-limrun-');
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('LIMRUN_API_KEY', 'lim_test_key');

  try {
    await captureConnectStdout(async () => {
      await connectCommand({
        host: createTestHostEnvironment(),
        positionals: ['limrun'],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          platform: 'android',
          tenant: 'team-a',
          runId: 'run-a',
          session: 'limrun-android',
          providerNetworkLogs: true,
          providerNetworkHosts: 'api.example',
        },
        client: {} as AgentDeviceClient,
      });
    });

    const state = readRequiredActiveState(stateDir);
    assert.equal(state.session, 'limrun-android');
    assert.equal(state.tenant, 'team-a');
    assert.equal(state.runId, 'run-a');
    assert.equal(state.leaseBackend, 'android-instance');
    assert.equal(state.leaseProvider, 'limrun');
    assert.equal(state.platform, 'android');
    assert.equal(state.daemon?.baseUrl, undefined);
    assert.match(
      state.remoteConfigPath,
      /remote-connections\/generated\/limrun-[a-f0-9]{16}\.json$/,
    );
    // The capture opt-in is read when the lease is allocated, so it must survive into the file
    // later commands resolve, not stop at this call's flags.
    assert.deepEqual(readGeneratedConfigKeys(state.remoteConfigPath), [
      'daemonTransport',
      'leaseBackend',
      'leaseProvider',
      'platform',
      'providerNetworkHosts',
      'providerNetworkLogs',
      'runId',
      'session',
      'sessionIsolation',
      'stateDir',
      'target',
      'tenant',
    ]);
    const generated = readGeneratedConfig(state.remoteConfigPath);
    assert.equal(generated.providerNetworkLogs, true);
    assert.equal(generated.providerNetworkHosts, 'api.example');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect limrun attaches to an existing instance without storing its token', async () => {
  const stateDir = path.join(mkdtempForTestSync('agent-device-connect-limrun-attach-'), '.state');
  const ios = { apiUrl: 'https://region.limrun.example/v1/ios_x/api', token: 'ios-instance-token' };
  vi.stubEnv('LIMRUN_API_KEY', '');
  vi.stubEnv('LIM_IOS_INSTANCE_URL', ios.apiUrl);
  vi.stubEnv('LIM_IOS_INSTANCE_TOKEN', ios.token);

  await captureConnectStdout(async () => {
    await connectCommand({
      host: createTestHostEnvironment(),
      positionals: ['limrun'],
      flags: { json: true, help: false, version: false, stateDir, platform: 'ios' },
      client: {} as AgentDeviceClient,
    });
  });

  const state = readRequiredActiveState(stateDir);
  assert.equal(state.leaseBackend, 'ios-instance');
  assert.doesNotMatch(fs.readFileSync(state.remoteConfigPath, 'utf8'), /ios-instance-token/);
  // Verification went to the instance named by the scoped variables, and not to the account API.
  assert.deepEqual(limrunSdk.attachedClients, [
    { ...ios, logLevel: 'none', maxReconnectAttempts: 0 },
  ]);
  assert.deepEqual(limrunSdk.accountClients, []);
});

test('connect limrun persists deferred Metro bridge settings', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-limrun-metro-');
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('LIMRUN_API_KEY', 'lim_test_key');

  try {
    await captureConnectStdout(async () => {
      await connectCommand({
        host: createTestHostEnvironment(),
        positionals: ['limrun'],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          platform: 'ios',
          tenant: 'team-a',
          runId: 'run-a',
          session: 'limrun-ios',
          metroProjectRoot: '/tmp/app',
          metroKind: 'expo',
          metroProxyBaseUrl: 'https://metro.agent-device.dev',
          metroBearerToken: 'adc_live_test',
          metroPreparePort: 8082,
          launchUrl: 'exp://127.0.0.1:8082',
        },
        client: {} as AgentDeviceClient,
      });
    });

    const state = readRequiredActiveState(stateDir);
    assert.equal(state.leaseBackend, 'ios-instance');
    assert.equal(state.leaseProvider, 'limrun');
    assert.equal(state.platform, 'ios');
    assert.deepEqual(readGeneratedConfig(state.remoteConfigPath), {
      daemonTransport: 'auto',
      launchUrl: 'exp://127.0.0.1:8082',
      leaseBackend: 'ios-instance',
      leaseProvider: 'limrun',
      metroKind: 'expo',
      metroPreparePort: 8082,
      metroProjectRoot: '/tmp/app',
      metroProxyBaseUrl: 'https://metro.agent-device.dev',
      platform: 'ios',
      runId: 'run-a',
      session: 'limrun-ios',
      sessionIsolation: 'tenant',
      stateDir,
      target: 'mobile',
      tenant: 'team-a',
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect limrun reconnects to the saved named session and profile', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-limrun-repeat-');
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('LIMRUN_API_KEY', 'lim_test_key');
  vi.useFakeTimers({ toFake: ['Date'] });
  const session = 'limrun-repeat';
  const savedRunId = `limrun-${buildConnectClientId('limrun', stateDir, session)}`;
  const connect = async (runId?: string) =>
    await captureConnectStdout(async () => {
      await connectCommand({
        host: createTestHostEnvironment(),
        positionals: ['limrun'],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          platform: 'android',
          session,
          ...(runId === undefined ? {} : { runId }),
        },
        client: {} as AgentDeviceClient,
      });
    });

  try {
    vi.setSystemTime(1_000);
    await connect(savedRunId);
    const first = readRequiredActiveState(stateDir);
    // Time passes between the two connects; the connection identity must not depend on it.
    vi.setSystemTime(90_000);
    await connect();
    const second = readRequiredActiveState(stateDir);

    assert.equal(second.runId, first.runId);
    assert.equal(second.remoteConfigPath, first.remoteConfigPath);
    assert.deepEqual(fs.readdirSync(path.join(stateDir, 'remote-connections', 'generated')), [
      path.basename(first.remoteConfigPath),
    ]);
  } finally {
    vi.useRealTimers();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('separate unscoped connect limrun calls get separate run ids', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-limrun-unscoped-');
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('LIMRUN_API_KEY', 'lim_test_key');
  const connect = async () => {
    await captureConnectStdout(async () => {
      await connectCommand({
        host: createTestHostEnvironment(),
        positionals: ['limrun'],
        flags: { json: true, help: false, version: false, stateDir, platform: 'android' },
        client: {} as AgentDeviceClient,
      });
    });
    return readRequiredActiveState(stateDir);
  };

  try {
    const first = await connect();
    const second = await connect();

    assert.notEqual(second.session, first.session);
    assert.notEqual(second.runId, first.runId);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect limrun requires LIMRUN_API_KEY or access to an existing instance', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-limrun-env-');
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('LIMRUN_API_KEY', '');
  vi.stubEnv('LIM_API_KEY', 'lim_test_key');
  vi.stubEnv('LIM_IOS_INSTANCE_URL', 'https://region.limrun.example/v1/ios_x/api');
  vi.stubEnv('LIM_IOS_INSTANCE_TOKEN', 'ios-instance-token');

  try {
    await assert.rejects(
      connectCommand({
        host: createTestHostEnvironment(),
        positionals: ['limrun'],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          platform: 'android',
        },
        client: {} as AgentDeviceClient,
      }),
      /connect limrun requires LIMRUN_API_KEY, or LIM_ANDROID_INSTANCE_URL, LIM_ANDROID_INSTANCE_TOKEN, LIM_ANDROID_INSTANCE_ADB_URL/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect limrun rejects unsupported public device and backend selections', async () => {
  const environment = { LIMRUN_API_KEY: 'lim_test_key', AGENT_DEVICE_SESSION: 'ci' };
  const device = await runCliCapture(
    ['connect', 'limrun', '--platform', 'ios', '--device', 'local-ios', '--json'],
    { env: environment, stateDirPrefix: 'agent-device-connect-limrun-scope-' },
  );
  assert.equal(device.code, 1);
  assert.match(device.stdout, /does not accept --device/);

  const platform = await runCliCapture(['connect', 'limrun', '--platform', 'macos', '--json'], {
    env: environment,
    stateDirPrefix: 'agent-device-connect-limrun-scope-',
  });
  assert.equal(platform.code, 1);
  assert.match(platform.stdout, /requires --platform ios or android/);

  const backend = await runCliCapture(
    ['connect', 'limrun', '--platform', 'ios', '--lease-backend', 'android-instance', '--json'],
    { env: environment, stateDirPrefix: 'agent-device-connect-limrun-scope-' },
  );
  assert.equal(backend.code, 1);
  assert.match(backend.stdout, /requires --lease-backend ios-instance/);
});

test('connect without remote config rejects legacy remoteConfig string profile response', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-cloud-legacy-');
  const stateDir = path.join(tempRoot, '.state');
  mockCloudConnectionProfile({
    remoteConfig: JSON.stringify({
      daemonBaseUrl: 'https://bridge.example.com/agent-device',
      daemonTransport: 'http',
      tenant: 'acme',
      runId: 'demo-run-001',
    }),
  });

  try {
    await assert.rejects(connectWithGeneratedCloudProfile(stateDir), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.match((error as Error).message, /did not include remoteConfigProfile/);
      return true;
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

for (const [status, code] of [
  [403, 'UNAUTHORIZED'],
  [429, 'COMMAND_FAILED'],
  [503, 'COMMAND_FAILED'],
] as const) {
  test(`connect without remote config preserves cloud profile ${status} failures`, async () => {
    const tempRoot = mkdtempForTestSync(`agent-device-connect-cloud-${status}-`);
    const stateDir = path.join(tempRoot, '.state');
    mockedResolveCloudAccessForConnect.mockResolvedValue({
      accessToken: 'adc_agent_cloud',
      cloudBaseUrl: 'https://cloud.example',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>private-body-secret</html>', { status })),
    );
    try {
      await assert.rejects(connectWithGeneratedCloudProfile(stateDir), (error: unknown) => {
        const normalized = normalizeError(error);
        assert.equal(normalized.code, code);
        assert.equal(normalized.details?.status, status);
        if (code === 'COMMAND_FAILED') assert.equal(normalized.retriable, true);
        assert.match(normalized.message, /Cloud connection profile endpoint rejected the request/);
        assert.doesNotMatch(JSON.stringify(normalized), /private-body-secret/);
        return true;
      });
      assert.equal(readActiveConnectionState({ stateDir }), null);
      assert.equal(fs.existsSync(path.join(stateDir, 'remote-connections')), false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}

test('connect without remote config reports unsupported cloud profile keys', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-cloud-invalid-');
  const stateDir = path.join(tempRoot, '.state');
  mockCloudConnectionProfile({
    remoteConfigProfile: {
      daemonBaseUrl: 'https://bridge.example.com/agent-device',
      tenant: 'acme',
      runId: 'demo-run-001',
      typoTenant: 'wrong',
    },
  });

  try {
    await assert.rejects(connectWithGeneratedCloudProfile(stateDir), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.match((error as Error).message, /invalid remote config/);
      return true;
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect output makes verified configuration, deferred device allocation, and app recovery explicit', async () => {
  const environment = { LIMRUN_API_KEY: 'lim_test_key', AGENT_DEVICE_SESSION: 'ci' };
  const result = await runCliCapture(['connect', 'limrun', '--platform', 'android'], {
    env: environment,
    stateDirPrefix: 'agent-device-connect-limrun-output-',
  });

  assert.equal(result.code, null);
  assert.match(result.stdout, /^Connected successfully with Limrun\./);
  assert.match(result.stdout, /Credentials and Android instance access verified/);
  assert.match(
    result.stdout,
    /Device: Provider-selected Android emulator — allocated on first device command/,
  );
  assert.match(
    result.stdout,
    /App: not installed yet — Run apps to choose an uploaded asset before allocation/,
  );
  assert.match(result.stdout, /No live device session has been created/);
  assert.match(result.stdout, /Next:/);
  assert.match(result.stdout, /agent-device apps --session ci/);
  assert.match(result.stdout, /agent-device open <uploaded-asset-name> --session ci/);
  assert.match(result.stdout, /agent-device install <package-id> <app-path> --session ci/);
  assert.match(result.stdout, /agent-device open <package-id> --relaunch --session ci/);
  assert.doesNotMatch(result.stdout, /lease pending/);
});

test('connect does not activate provider state when verification fails', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-verify-fail-');
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('LIMRUN_API_KEY', 'lim_bad_key');
  // The account answers the read-only check as it answers a rejected key, and the provider turns
  // that into its typed refusal.
  limrunSdk.accountList.mockRejectedValueOnce(Object.assign(new Error('invalid'), { status: 401 }));

  try {
    await assert.rejects(
      connectCommand({
        host: createTestHostEnvironment(),
        positionals: ['limrun'],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          platform: 'android',
        },
        client: {} as AgentDeviceClient,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'UNAUTHORIZED');
        assert.doesNotMatch(JSON.stringify(error), /lim_bad_key/);
        return true;
      },
    );
    assert.equal(readActiveConnectionState({ stateDir }), null);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function mockCloudConnectionProfile(connection: Record<string, unknown>): ReturnType<typeof vi.fn> {
  mockedResolveCloudAccessForConnect.mockResolvedValue({
    accessToken: 'adc_agent_cloud',
    cloudBaseUrl: 'https://cloud.example',
  });
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, connection }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function assertGeneratedProfileState(state: RemoteConnectionState): void {
  assert.equal(state.tenant, 'acme');
  assert.equal(state.runId, 'demo-run-001');
  assert.equal(state.leaseProvider, 'cloud');
  assert.match(state.clientId ?? '', /^[a-f0-9]{16}$/);
  assert.equal(state.daemon?.baseUrl, 'https://bridge.example.com/agent-device');
  assert.match(state.remoteConfigPath, /remote-connections\/generated\/cloud-[a-f0-9]{16}\.json$/);
  assert.equal(state.remoteConfigHash, hashRemoteConfigFile(state.remoteConfigPath));
  assert.deepEqual(readGeneratedConfigKeys(state.remoteConfigPath), [
    'clientId',
    'daemonBaseUrl',
    'daemonTransport',
    'leaseProvider',
    'metroKind',
    'metroProxyBaseUrl',
    'metroPublicBaseUrl',
    'runId',
    'sessionIsolation',
    'tenant',
  ]);
  const generated = readGeneratedConfig(state.remoteConfigPath);
  assert.equal(generated.tenant, 'acme');
  assert.equal(generated.leaseProvider, 'cloud');
  assert.equal(generated.clientId, state.clientId);
}

function fetchProfileUrl(fetchMock: ReturnType<typeof vi.fn>): string | undefined {
  return fetchMock.mock.calls[0]?.[0]?.toString();
}

async function connectWithGeneratedCloudProfile(stateDir: string): Promise<void> {
  await captureConnectStdout(async () => {
    await connectCommand({
      host: createTestHostEnvironment(),
      positionals: [],
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
      },
      client: {} as AgentDeviceClient,
    });
  });
}

async function captureConnectStdout(task: () => Promise<void>): Promise<void> {
  const stdoutCapture = beginStdoutCapture();
  try {
    await task();
  } finally {
    stdoutCapture.restore();
  }
}

function readGeneratedConfig(configPath: string): {
  tenant?: string;
  leaseProvider?: string;
  clientId?: string;
  providerApp?: string;
  providerOsVersion?: string;
  providerProject?: string;
  providerBuild?: string;
  providerNetworkLogs?: boolean;
  providerNetworkHosts?: string;
  awsProjectArn?: string;
  awsDeviceArn?: string;
  awsAppArn?: string;
  awsRegion?: string;
  awsInteractionMode?: string;
} {
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    tenant?: string;
    leaseProvider?: string;
    clientId?: string;
    providerApp?: string;
    providerOsVersion?: string;
    providerProject?: string;
    providerBuild?: string;
    providerNetworkLogs?: boolean;
    providerNetworkHosts?: string;
    awsProjectArn?: string;
    awsDeviceArn?: string;
    awsAppArn?: string;
    awsRegion?: string;
    awsInteractionMode?: string;
  };
}

function readGeneratedConfigKeys(configPath: string): string[] {
  return Object.keys(readGeneratedConfig(configPath));
}

function readRequiredActiveState(stateDir: string): RemoteConnectionState {
  const state = readActiveConnectionState({ stateDir });
  assert.ok(state);
  return state;
}
