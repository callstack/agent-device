import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connectCommand } from '../cli/commands/connection.ts';
import { resolveCloudAccessForConnect } from '../cli/auth-session.ts';
import { runCliCapture } from './cli-capture.ts';
import {
  hashRemoteConfigFile,
  readActiveConnectionState,
  readRemoteConnectionState,
  type RemoteConnectionState,
} from '../remote/remote-connection-state.ts';
import type { AgentDeviceClient } from '../agent-device-client.ts';
import { resolveCloudWebDriverConnectProfile } from '../cli/connection/cloud-webdriver-profile.ts';
import { AppError } from '@agent-device/kernel/errors';
import { verifyLimrunConnection } from '@agent-device/provider-limrun';
import { providerWebDriver } from '../provider-webdriver.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

vi.mock('../cli/auth-session.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cli/auth-session.ts')>()),
  resolveCloudAccessForConnect: vi.fn(),
}));

vi.mock('@agent-device/provider-limrun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/provider-limrun')>()),
  verifyLimrunConnection: vi.fn(),
}));

vi.mock('../provider-webdriver.ts', () => ({
  providerWebDriver: { verifyConnection: vi.fn() },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const mockedResolveCloudAccessForConnect = vi.mocked(resolveCloudAccessForConnect);
const mockedVerifyLimrunConnection = vi.mocked(verifyLimrunConnection);
const mockedVerifyWebDriverConnection = vi.mocked(providerWebDriver.verifyConnection);

beforeEach(() => {
  mockedVerifyLimrunConnection.mockResolvedValue({
    provider: 'limrun',
    service: 'Limrun',
    verificationMessage: 'Credentials and Android instance access verified.',
    device: {
      status: 'deferred',
      name: 'Provider-selected Android emulator',
      platform: 'android',
    },
    app: {
      status: 'missing',
      message: 'A new Limrun instance does not have your app yet.',
    },
  });
  mockedVerifyWebDriverConnection.mockImplementation(async (options) =>
    options.provider === 'browserstack'
      ? {
          provider: 'browserstack',
          service: 'BrowserStack',
          verificationMessage: 'Credentials, device, and uploaded app verified.',
          device: {
            status: 'verified',
            name: options.deviceName,
            platform: options.platform,
            osVersion: options.osVersion,
          },
          app: { status: 'verified', reference: options.app },
        }
      : {
          provider: 'aws-device-farm',
          service: 'AWS Device Farm',
          verificationMessage: 'Credentials, project, and device verified.',
          project: { name: 'Agent Device', reference: options.projectArn },
          device: {
            status: 'verified',
            name: 'iPhone 15',
            reference: options.deviceArn,
            platform: options.platform,
            osVersion: '17',
          },
          app: {
            status: 'missing',
            message:
              'No app upload is attached; AWS Device Farm does not support install after allocation.',
          },
        },
  );
});

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
  const human = await runCliCapture(['connect'], {
    stateDirPrefix: 'agent-device-connect-cloud-wording-human-',
  });
  assert.match(human.stdout, /^Connected successfully with the configured cloud service\./);

  mockCloudConnectionProfile(profile);
  const json = await runCliCapture(['connect', '--json'], {
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-limrun-metro-');
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-limrun-env-');
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

test('connect without remote config reports cloud profile authorization failures', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-cloud-denied-');
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

test('connect browserstack generates local provider profile without credentials', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-browserstack-');
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

test('connect --remote-config verifies a direct provider profile before saving state', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-provider-config-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfig = path.join(tempRoot, 'browserstack.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      tenant: 'browserstack',
      runId: 'browserstack-config',
      sessionIsolation: 'tenant',
      leaseProvider: 'browserstack',
      leaseBackend: 'android-instance',
      platform: 'android',
      target: 'mobile',
      device: 'Google Pixel 8',
      providerOsVersion: '14.0',
      providerApp: 'bs://app-id',
    }),
  );
  vi.stubEnv('BROWSERSTACK_USERNAME', 'browser-user');
  vi.stubEnv('BROWSERSTACK_ACCESS_KEY', 'browser-key');

  try {
    await connectWithGeneratedProviderProfile({
      stateDir,
      positionals: [],
      flags: { remoteConfig },
    });

    assert.equal(mockedVerifyWebDriverConnection.mock.calls.length, 1);
    assert.deepEqual(mockedVerifyWebDriverConnection.mock.calls[0]?.[0], {
      provider: 'browserstack',
      username: 'browser-user',
      accessKey: 'browser-key',
      platform: 'android',
      deviceName: 'Google Pixel 8',
      osVersion: '14.0',
      app: 'bs://app-id',
    });
    assert.equal(readRequiredActiveState(stateDir).remoteConfigPath, remoteConfig);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect browserstack persists a local app artifact as an absolute path', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-browserstack-app-');
  const stateDir = path.join(tempRoot, '.state');
  const appPath = path.join(tempRoot, 'sample.apk');
  fs.writeFileSync(appPath, 'fixture');
  vi.stubEnv('BROWSERSTACK_USERNAME', 'browser-user');
  vi.stubEnv('BROWSERSTACK_ACCESS_KEY', 'browser-key');

  try {
    const previousCwd = process.cwd();
    process.chdir(tempRoot);
    try {
      await connectWithGeneratedProviderProfile({
        stateDir,
        positionals: ['browserstack'],
        flags: {
          platform: 'android',
          device: 'Google Pixel 8',
          providerOsVersion: '14.0',
          providerApp: './sample.apk',
        },
      });
    } finally {
      process.chdir(previousCwd);
    }

    const state = readRequiredActiveState(stateDir);
    assert.equal(readGeneratedConfig(state.remoteConfigPath).providerApp, fs.realpathSync(appPath));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect aws-device-farm generates local provider profile from flags', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-aws-');
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

test('connect output makes verified configuration, deferred device allocation, and app recovery explicit', async () => {
  const environment = { LIMRUN_API_KEY: 'lim_test_key' };
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
    /App: not installed yet — A new Limrun instance does not have your app yet/,
  );
  assert.match(result.stdout, /No live device session has been created/);
  assert.match(result.stdout, /Next:/);
  assert.match(result.stdout, /agent-device install <package-id> <app-path-or-url>/);
  assert.match(result.stdout, /agent-device open <package-id> --relaunch/);
  assert.doesNotMatch(result.stdout, /lease pending/);
});

test('connect JSON exposes verification, device, app, live-session, and next-step state', async () => {
  const result = await runCliCapture(
    [
      'connect',
      'aws-device-farm',
      '--platform',
      'ios',
      '--aws-project-arn',
      'project-arn',
      '--aws-device-arn',
      'device-arn',
      '--json',
    ],
    { stateDirPrefix: 'agent-device-connect-aws-output-' },
  );

  assert.equal(result.code, null);
  const output = (JSON.parse(result.stdout) as { data: Record<string, any> }).data;
  assert.equal(output.verification.status, 'verified');
  assert.equal(output.device.name, 'iPhone 15');
  assert.equal(output.app.status, 'missing');
  assert.equal(output.liveSession.status, 'not-created');
  assert.deepEqual(output.nextSteps, [
    `agent-device connect aws-device-farm --platform ios --aws-project-arn project-arn --aws-device-arn device-arn --aws-app-arn <arn> --force --session ${output.session}`,
    `agent-device open <bundle-id> --relaunch --session ${output.session}`,
  ]);
  assert.deepEqual(output.leasePreparation.nextSteps, output.nextSteps);
  assert.deepEqual(output.notes, [
    `After close, run agent-device artifacts --json --session ${output.session} for provider video and logs.`,
  ]);
});

test('connect JSON preserves BrowserStack workflow notes from human output', async () => {
  const result = await runCliCapture(
    [
      'connect',
      'browserstack',
      '--platform',
      'android',
      '--device',
      'Google Pixel 8',
      '--provider-os-version',
      '14.0',
      '--provider-app',
      'bs://app-id',
      '--json',
    ],
    {
      env: {
        BROWSERSTACK_USERNAME: 'browser-user',
        BROWSERSTACK_ACCESS_KEY: 'browser-key',
      },
      stateDirPrefix: 'agent-device-connect-browserstack-json-',
    },
  );

  assert.equal(result.code, null);
  const output = (JSON.parse(result.stdout) as { data: Record<string, any> }).data;
  assert.deepEqual(output.nextSteps, [
    `agent-device open <package-id> --relaunch --session ${output.session}`,
  ]);
  assert.deepEqual(output.notes, [
    'Use the installed package or bundle identifier in open, not the app artifact name.',
    `After close, run agent-device artifacts --json --session ${output.session} for provider video and logs.`,
  ]);
});

test('every command BrowserStack connect emits resolves back to the connection that emitted it', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-scoped-commands-');
  const stateDir = path.join(tempRoot, '.state');
  const browserstackArgs = [
    'connect',
    'browserstack',
    '--platform',
    'android',
    '--device',
    'Google Pixel 8',
    '--provider-os-version',
    '14.0',
    '--provider-app',
    'bs://app-id',
    '--state-dir',
    stateDir,
  ];
  const captureOptions = {
    env: { BROWSERSTACK_USERNAME: 'browser-user', BROWSERSTACK_ACCESS_KEY: 'browser-key' },
  };

  try {
    const json = await runCliCapture([...browserstackArgs, '--json'], captureOptions);
    const human = await runCliCapture(browserstackArgs, captureOptions);

    assert.equal(json.code, null);
    assert.equal(human.code, null);
    const output = (JSON.parse(json.stdout) as { data: Record<string, any> }).data;
    const session: string = output.session;

    // Every emitted command — nextSteps AND the prose notes — must name a
    // session, so following one cannot adopt whichever connection happens to
    // be host-global active in a concurrent run.
    for (const line of [...output.nextSteps, ...output.notes]) {
      assertCommandsAreSessionScoped(line, session);
    }
    assert.deepEqual([...readEmittedSessions([...output.nextSteps, ...output.notes])], [session]);

    // The human run is a second unscoped connect, so it mints its own identity;
    // its commands must name THAT one, not the JSON run's.
    const humanSessions = [...readEmittedSessions([human.stdout])];
    assert.equal(humanSessions.length, 1, human.stdout);
    const humanSession = humanSessions[0] ?? '';
    assert.notEqual(humanSession, session);
    assertCommandsAreSessionScoped(human.stdout, humanSession);

    // The scope is not decoration: resolving each emitted --session lands on
    // the connection state that connect wrote.
    for (const emittedSession of [session, humanSession]) {
      const state = readRemoteConnectionState({ stateDir, session: emittedSession });
      assert.equal(state?.session, emittedSession);
      assert.equal(state?.leaseProvider, 'browserstack');
      assert.equal(state?.tenant, 'browserstack');
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

/**
 * A command-bearing string must carry one `--session <name>` per `agent-device`
 * invocation it suggests. Counting rather than matching means an added command
 * cannot silently ship unscoped alongside a scoped sibling.
 */
function assertCommandsAreSessionScoped(text: string, session: string): void {
  const commands = text.match(/agent-device\s+[a-z]/g)?.length ?? 0;
  const scopes = text.split(`--session ${session}`).length - 1;
  assert.equal(scopes, commands, `unscoped suggested command in: ${text}`);
}

function readEmittedSessions(texts: readonly string[]): Set<string> {
  const sessions = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/--session\s+(\S+)/g)) {
      const value = match[1];
      if (value) sessions.add(value);
    }
  }
  return sessions;
}

test('connect does not activate provider state when verification fails', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-verify-fail-');
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('LIMRUN_API_KEY', 'lim_bad_key');
  mockedVerifyLimrunConnection.mockRejectedValueOnce(
    new AppError('UNAUTHORIZED', 'Limrun rejected connection verification.'),
  );

  try {
    await assert.rejects(
      connectCommand({
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
        return true;
      },
    );
    assert.equal(readActiveConnectionState({ stateDir }), null);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect aws-device-farm rejects BrowserStack-only device-feature flags', () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-aws-reject-');

  try {
    assert.throws(
      () =>
        resolveCloudWebDriverConnectProfile({
          provider: 'aws-device-farm',
          stateDir: path.join(tempRoot, '.state'),
          cwd: tempRoot,
          env: {},
          flags: {
            json: false,
            help: false,
            version: false,
            platform: 'android',
            device: 'Google Pixel 8',
            providerDeviceOrientation: 'portrait',
            providerTimezone: 'New_York',
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        // Names every offending flag, and fires before the provider's own required-arg checks so
        // the caller is told what is unsupported rather than what else is missing.
        assert.match(error.message, /--provider-device-orientation, --provider-timezone/);
        assert.match(error.message, /only supported by BrowserStack, not aws-device-farm/);
        assert.deepEqual(error.details?.flags, [
          '--provider-device-orientation',
          '--provider-timezone',
        ]);
        return true;
      },
    );
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
