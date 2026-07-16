import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectCommand } from '../cli/commands/connection.ts';
import { resolveCloudAccessForConnect } from '../cli/auth-session.ts';
import { runCliCapture } from './cli-capture.ts';
import {
  hashRemoteConfigFile,
  readActiveConnectionState,
  type RemoteConnectionState,
} from '../remote/remote-connection-state.ts';
import type { AgentDeviceClient } from '../agent-device-client.ts';

vi.mock('../cli/auth-session.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cli/auth-session.ts')>()),
  resolveCloudAccessForConnect: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mockedResolveCloudAccessForConnect = vi.mocked(resolveCloudAccessForConnect);

test('connect without remote config generates one from cloud connection profile', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-cloud-'));
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

test('connect limrun generates a local daemon remote profile', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-limrun-'));
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('LIMRUN_API_KEY', 'lim_test_key');

  try {
    await captureConnectStdout(async () => {
      await connectCommand({
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
    assert.deepEqual(readGeneratedConfigKeys(state.remoteConfigPath), [
      'daemonTransport',
      'leaseBackend',
      'leaseProvider',
      'platform',
      'runId',
      'session',
      'sessionIsolation',
      'stateDir',
      'target',
      'tenant',
    ]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect limrun persists deferred Metro bridge settings', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-limrun-metro-'));
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('LIMRUN_API_KEY', 'lim_test_key');

  try {
    await captureConnectStdout(async () => {
      await connectCommand({
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

test('connect limrun requires LIMRUN_API_KEY', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-limrun-env-'));
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('LIMRUN_API_KEY', '');
  vi.stubEnv('LIM_API_KEY', 'lim_test_key');

  try {
    await assert.rejects(
      connectCommand({
        positionals: ['limrun'],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
        },
        client: {} as AgentDeviceClient,
      }),
      /connect limrun requires LIMRUN_API_KEY/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect limrun rejects unsupported public device and backend selections', async () => {
  const environment = { LIMRUN_API_KEY: 'lim_test_key' };
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-cloud-legacy-'));
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

test('connect without remote config reports cloud profile authorization failures', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-cloud-denied-'));
  const stateDir = path.join(tempRoot, '.state');
  mockedResolveCloudAccessForConnect.mockResolvedValue({
    accessToken: 'adc_agent_cloud',
    cloudBaseUrl: 'https://cloud.example',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'forbidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );

  try {
    await assert.rejects(connectWithGeneratedCloudProfile(stateDir), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'UNAUTHORIZED');
      assert.match(
        (error as Error).message,
        /Cloud connection profile endpoint rejected the request/,
      );
      return true;
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect without remote config reports unsupported cloud profile keys', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-cloud-invalid-'));
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

test('connect browserstack generates local provider profile without credentials', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-browserstack-'));
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('BROWSERSTACK_USERNAME', 'browser-user');
  vi.stubEnv('BROWSERSTACK_ACCESS_KEY', 'browser-key');

  try {
    await connectWithGeneratedProviderProfile({
      stateDir,
      positionals: ['browserstack'],
      flags: {
        platform: 'android',
        device: 'Google Pixel 8',
        providerOsVersion: '14.0',
        providerApp: 'bs://app-id',
        providerProject: 'agent-device',
        providerBuild: 'build-a',
      },
    });

    const state = readRequiredActiveState(stateDir);
    assert.equal(state.tenant, 'browserstack');
    assert.equal(state.leaseProvider, 'browserstack');
    assert.equal(state.daemon?.baseUrl, undefined);
    assert.match(state.remoteConfigPath, /generated\/browserstack-[a-f0-9]{16}\.json$/);
    const generated = readGeneratedConfig(state.remoteConfigPath);
    assert.equal(generated.providerApp, 'bs://app-id');
    assert.equal(generated.providerOsVersion, '14.0');
    assert.equal(generated.providerProject, 'agent-device');
    assert.equal(generated.providerBuild, 'build-a');
    assert.equal(JSON.stringify(generated).includes('browser-key'), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect aws-device-farm generates local provider profile from flags', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-aws-'));
  const stateDir = path.join(tempRoot, '.state');

  try {
    await connectWithGeneratedProviderProfile({
      stateDir,
      positionals: ['aws-device-farm'],
      flags: {
        platform: 'ios',
        device: 'Apple iPhone 15',
        awsProjectArn: 'arn:aws:devicefarm:us-west-2:123:project:project-a',
        awsDeviceArn: 'arn:aws:devicefarm:us-west-2::device:device-a',
        awsAppArn: 'arn:aws:devicefarm:us-west-2:123:upload:app-a',
        awsRegion: 'us-west-2',
        awsInteractionMode: 'INTERACTIVE',
      },
    });

    const state = readRequiredActiveState(stateDir);
    assert.equal(state.tenant, 'aws-device-farm');
    assert.equal(state.leaseProvider, 'aws-device-farm');
    assert.equal(state.daemon?.baseUrl, undefined);
    assert.match(state.remoteConfigPath, /generated\/aws-device-farm-[a-f0-9]{16}\.json$/);
    const generated = readGeneratedConfig(state.remoteConfigPath);
    assert.equal(generated.awsProjectArn, 'arn:aws:devicefarm:us-west-2:123:project:project-a');
    assert.equal(generated.awsDeviceArn, 'arn:aws:devicefarm:us-west-2::device:device-a');
    assert.equal(generated.awsAppArn, 'arn:aws:devicefarm:us-west-2:123:upload:app-a');
    assert.equal(generated.awsRegion, 'us-west-2');
    assert.equal(generated.awsInteractionMode, 'INTERACTIVE');
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
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await task();
  } finally {
    stdoutWrite.mockRestore();
  }
}

async function connectWithGeneratedProviderProfile(options: {
  stateDir: string;
  positionals: string[];
  flags: Partial<Parameters<typeof connectCommand>[0]['flags']>;
}): Promise<void> {
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await connectCommand({
      positionals: options.positionals,
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir: options.stateDir,
        ...options.flags,
      },
      client: {} as AgentDeviceClient,
    });
  } finally {
    stdoutWrite.mockRestore();
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
