import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCliCapture } from '../../__tests__/cli-capture.ts';
import {
  readActiveConnectionState,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { AppError } from '@agent-device/kernel/errors';
import { verifyAwsDeviceFarmConnection } from '@agent-device/aws-device-farm/connection-verification';
import awsDeviceFarm from '@agent-device/aws-device-farm';
import { resolveProviderPlugins } from '@agent-device/plugins/registry';
import {
  resolveConnectProviderProfile,
  verifyResolvedConnectProvider,
} from './connect-provider-adapters.ts';
import {
  mkdtempForTestSync,
  pluginHome,
  selectPlugin,
  pluginSource,
  bindTestCommandHost,
} from '@agent-device/test-kit';
import manifest from '@agent-device/aws-device-farm/package.json' with { type: 'json' };
import type { PluginConnectionCallbacks } from '@agent-device/plugins/connection';
import { connectWithGeneratedProviderProfile } from '../../__tests__/test-utils/connect-command.ts';
import { providerContributionOf } from '@agent-device/plugins/validate';

bindTestCommandHost();

vi.mock('@agent-device/aws-device-farm/connection-verification', () => ({
  verifyAwsDeviceFarmConnection: vi.fn(),
}));
vi.mock('@agent-device/plugins/load', () => ({
  withPluginConnection: async (
    _provider: string,
    _builtinProviders: readonly string[],
    _env: NodeJS.ProcessEnv,
    runConnection: (connection: PluginConnectionCallbacks) => Promise<unknown>,
  ) => {
    const { connections } = await resolveProviderPlugins([
      { source: 'store', package: manifest.name, load: () => awsDeviceFarm() },
    ]);
    return await runConnection(connections.get('aws-device-farm')!);
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const mockedVerifyAwsDeviceFarmConnection = vi.mocked(verifyAwsDeviceFarmConnection);

test('connection verification carries the caller host to the provider command', async () => {
  const cwd = fs.realpathSync(mkdtempForTestSync('connect-aws-host-'));
  let observed: unknown;
  mockedVerifyAwsDeviceFarmConnection.mockImplementationOnce(async (_options, run) => {
    const result = await run(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify([process.cwd(), process.env.CONNECT_HOST_VALUE]))',
    ]);
    observed = JSON.parse(result.stdout);
    return {
      provider: 'aws-device-farm',
      service: 'AWS Device Farm',
      verificationMessage: 'ok',
      project: { reference: 'project' },
      device: { status: 'verified' },
      app: { status: 'missing' },
    };
  });
  await verifyResolvedConnectProvider(
    {
      provider: 'aws-device-farm',
      remoteConfigPath: '/unused',
      flags: {
        json: false,
        help: false,
        version: false,
        platform: 'ios',
        awsProjectArn: 'project',
        awsDeviceArn: 'device',
      },
    },
    { cwd, env: { CONNECT_HOST_VALUE: 'supplied' } },
  );
  assert.deepEqual(observed, [cwd, 'supplied']);
});

let pluginHomeDir = '';

beforeEach(() => {
  const { home } = pluginHome();
  pluginHomeDir = home;
  // The store declares the plugin installed with AWS Device Farm's capabilities; the mocked loader
  // above supplies the workspace factory those assertions exercise.
  selectPlugin(
    home,
    manifest.name,
    pluginSource('aws-device-farm', {
      extra: `connection: { capabilities: ${JSON.stringify(providerContributionOf(awsDeviceFarm()).connection?.capabilities)}, resolve() {}, verify() {} },`,
    }),
  );
  vi.stubEnv('AGENT_DEVICE_HOME', home);
  mockedVerifyAwsDeviceFarmConnection.mockImplementation(async (options) => ({
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
  }));
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
    // The plugin verifies through the host command, and the profile carries the region its ARN names.
    assert.equal(mockedVerifyAwsDeviceFarmConnection.mock.calls[0]?.[0].region, 'us-west-2');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect aws-device-farm JSON exposes verification, device, app, live-session, and next-step state', async () => {
  const result = await runCliCapture(
    [
      'connect',
      'aws-device-farm',
      '--session=ci',
      '--platform',
      'ios',
      '--aws-project-arn',
      'project-arn',
      '--aws-device-arn',
      'device-arn',
      '--json',
    ],
    {
      env: { AGENT_DEVICE_HOME: pluginHomeDir },
      stateDirPrefix: 'agent-device-connect-aws-output-',
    },
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

test('connect aws-device-farm rejects device-feature flags it does not read', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-aws-reject-');

  try {
    await assert.rejects(
      resolveConnectProviderProfile({
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
        assert.equal(error.details?.provider, 'aws-device-farm');
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

test('connect aws-device-farm refuses --provider-device-type before saving a profile', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-aws-device-type-');

  try {
    await assert.rejects(
      resolveConnectProviderProfile({
        provider: 'aws-device-farm',
        stateDir: path.join(tempRoot, '.state'),
        cwd: tempRoot,
        env: {},
        flags: {
          json: false,
          help: false,
          version: false,
          platform: 'android',
          awsProjectArn: 'arn:aws:devicefarm:us-west-2:123:project/p',
          awsDeviceArn: 'arn:aws:devicefarm:us-west-2::device/d',
          providerDeviceType: 'real',
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        assert.match(error.message, /^--provider-device-type is not supported by /);
        assert.equal(error.details?.provider, 'aws-device-farm');
        return true;
      },
    );
    assert.equal(fs.existsSync(path.join(tempRoot, '.state')), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function readGeneratedConfig(configPath: string): {
  awsProjectArn?: string;
  awsDeviceArn?: string;
  awsAppArn?: string;
  awsRegion?: string;
  awsInteractionMode?: string;
} {
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    awsProjectArn?: string;
    awsDeviceArn?: string;
    awsAppArn?: string;
    awsRegion?: string;
    awsInteractionMode?: string;
  };
}

function readRequiredActiveState(stateDir: string): RemoteConnectionState {
  const state = readActiveConnectionState({ stateDir });
  assert.ok(state);
  return state;
}
