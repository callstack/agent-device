import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCliCapture } from '../../__tests__/cli-capture.ts';
import {
  readActiveConnectionState,
  readRemoteConnectionState,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { AppError } from '@agent-device/kernel/errors';
import { verifyBrowserStackConnection } from '@agent-device/browserstack/connection-verification';
import browserstack from '@agent-device/browserstack';
import { resolveProviderPlugins } from '@agent-device/plugins/registry';
import { resolveConnectProviderProfile } from '../connection/connect-provider-adapters.ts';
import {
  mkdtempForTestSync,
  pluginHome,
  selectV2Plugin,
  v2RegistrationSource,
  bindTestCommandHost,
} from '@agent-device/test-kit';
import manifest from '@agent-device/browserstack/package.json' with { type: 'json' };
import type { PluginConnectionCallbacks } from '@agent-device/plugins/connection';
import { connectWithGeneratedProviderProfile } from '../../__tests__/test-utils/connect-command.ts';

bindTestCommandHost();

const CREDENTIALS = {
  BROWSERSTACK_USERNAME: 'browser-user',
  BROWSERSTACK_ACCESS_KEY: 'browser-key',
};

vi.mock('@agent-device/browserstack/connection-verification', () => ({
  verifyBrowserStackConnection: vi.fn(),
}));
vi.mock('@agent-device/plugins/load', () => ({
  withPluginConnection: async (
    _provider: string,
    _builtinProviders: readonly string[],
    _env: NodeJS.ProcessEnv,
    runConnection: (connection: PluginConnectionCallbacks) => Promise<unknown>,
  ) => {
    const { connections } = await resolveProviderPlugins([
      { source: 'store', package: manifest.name, load: () => browserstack() },
    ]);
    return await runConnection(connections.get('browserstack')!);
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const mockedVerifyBrowserStackConnection = vi.mocked(verifyBrowserStackConnection);

let pluginHomeDir = '';

beforeEach(() => {
  const { home } = pluginHome();
  pluginHomeDir = home;
  // The store declares the plugin installed with BrowserStack's capabilities; the mocked loader
  // above supplies the workspace factory those assertions exercise.
  selectV2Plugin(
    home,
    manifest.name,
    v2RegistrationSource('browserstack', {
      extra: `connection: { capabilities: ${JSON.stringify(browserstack().connection?.capabilities)}, resolve() {}, verify() {} },`,
      credentials: '{ variables: ["BROWSERSTACK_USERNAME", "BROWSERSTACK_ACCESS_KEY"] }',
    }),
  );
  vi.stubEnv('AGENT_DEVICE_HOME', home);
  mockedVerifyBrowserStackConnection.mockImplementation(async (options) => ({
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
  }));
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

test('connect browserstack canonicalizes the app scheme and refuses a malformed bs:// id', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-browserstack-ref-');
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('BROWSERSTACK_USERNAME', 'browser-user');
  vi.stubEnv('BROWSERSTACK_ACCESS_KEY', 'browser-key');
  const flags = {
    platform: 'android' as const,
    device: 'Google Pixel 8',
    providerOsVersion: '14.0',
  };

  try {
    await connectWithGeneratedProviderProfile({
      stateDir,
      positionals: ['browserstack'],
      flags: { ...flags, providerApp: 'Bs://app-id' },
    });
    assert.equal(
      readGeneratedConfig(readRequiredActiveState(stateDir).remoteConfigPath).providerApp,
      'bs://app-id',
    );
    // Verification must look up the reference the profile saved, not the spelling typed.
    assert.equal(mockedVerifyBrowserStackConnection.mock.calls[0]?.[0].app, 'bs://app-id');

    for (const app of ['bs://', 'bs://a b', 'BS://a/b']) {
      await assert.rejects(
        resolveConnectProviderProfile({
          provider: 'browserstack',
          stateDir,
          cwd: tempRoot,
          env: CREDENTIALS,
          flags: { json: false, help: false, version: false, ...flags, providerApp: app },
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'INVALID_ARGS');
          assert.equal(error.message, `BrowserStack --provider-app ${app} is not a bs:// app id.`);
          assert.deepEqual(error.details, {
            providerApp: app,
            hint: 'Pass <bs://app-id-or-local-path>.',
          });
          return true;
        },
      );
    }
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

    assert.equal(mockedVerifyBrowserStackConnection.mock.calls.length, 1);
    assert.deepEqual(mockedVerifyBrowserStackConnection.mock.calls[0]?.[0], {
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
    // The host the command runs in decides what `./sample.apk` is relative to.
    await connectWithGeneratedProviderProfile({
      stateDir,
      host: { env: process.env, cwd: fs.realpathSync(tempRoot) },
      positionals: ['browserstack'],
      flags: {
        platform: 'android',
        device: 'Google Pixel 8',
        providerOsVersion: '14.0',
        providerApp: './sample.apk',
      },
    });

    const state = readRequiredActiveState(stateDir);
    assert.equal(readGeneratedConfig(state.remoteConfigPath).providerApp, fs.realpathSync(appPath));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect browserstack refuses AWS Device Farm flags', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-browserstack-reject-');

  try {
    await assert.rejects(
      resolveConnectProviderProfile({
        provider: 'browserstack',
        stateDir: path.join(tempRoot, '.state'),
        cwd: tempRoot,
        env: CREDENTIALS,
        flags: {
          json: false,
          help: false,
          version: false,
          platform: 'android',
          device: 'Google Pixel 8',
          providerOsVersion: '14.0',
          providerApp: 'bs://app-id',
          awsProjectArn: 'arn:aws:devicefarm:us-west-2:123:project:project-a',
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        assert.equal(error.details?.provider, 'browserstack');
        assert.deepEqual(error.details?.flags, ['--aws-project-arn']);
        return true;
      },
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect browserstack refuses --provider-device-type before saving a profile', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-browserstack-device-type-');

  try {
    await assert.rejects(
      resolveConnectProviderProfile({
        provider: 'browserstack',
        stateDir: path.join(tempRoot, '.state'),
        cwd: tempRoot,
        env: CREDENTIALS,
        flags: {
          json: false,
          help: false,
          version: false,
          platform: 'android',
          device: 'Google Pixel 8',
          providerOsVersion: '14.0',
          providerApp: 'bs://app-id',
          providerDeviceType: 'real',
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        assert.match(error.message, /^--provider-device-type is not supported by /);
        assert.equal(error.details?.provider, 'browserstack');
        return true;
      },
    );
    assert.equal(fs.existsSync(path.join(tempRoot, '.state')), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect browserstack JSON preserves the workflow notes from human output', async () => {
  const result = await runCliCapture(
    [
      'connect',
      'browserstack',
      '--session=ci',
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
      env: { ...CREDENTIALS, AGENT_DEVICE_HOME: pluginHomeDir },
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
  const captureOptions = { env: { ...CREDENTIALS, AGENT_DEVICE_HOME: pluginHomeDir } };

  try {
    const json = await runCliCapture(
      [...browserstackArgs, '--session=bs-1', '--json'],
      captureOptions,
    );
    const human = await runCliCapture([...browserstackArgs, '--session=bs-2'], captureOptions);

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

    // The human run is a second connect under its own session; its commands must name THAT one,
    // not the JSON run's.
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

function readGeneratedConfig(configPath: string): {
  providerApp?: string;
  providerOsVersion?: string;
  providerProject?: string;
  providerBuild?: string;
} {
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    providerApp?: string;
    providerOsVersion?: string;
    providerProject?: string;
    providerBuild?: string;
  };
}

function readRequiredActiveState(stateDir: string): RemoteConnectionState {
  const state = readActiveConnectionState({ stateDir });
  assert.ok(state);
  return state;
}
