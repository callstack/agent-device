import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ProviderPluginHost, AgentDevicePlugin } from 'agent-device/plugins';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceLease, ProviderDeviceRuntime } from '@agent-device/contracts/device';
import awsDeviceFarm from './index.ts';
import { createAwsDeviceFarmWebDriver } from './aws-device-farm-webdriver.ts';

function providerOf<P extends AgentDevicePlugin>(plugin: P) {
  const [contribution] = plugin.contributes;
  if (contribution.kind !== 'provider') throw new Error('expected a provider contribution');
  return contribution as Extract<P['contributes'][number], { kind: 'provider' }>;
}

const DEVICE_ARN = 'arn:aws:devicefarm:us-west-2::device:device-a';

function host(env: Record<string, string | undefined> = {}): ProviderPluginHost {
  return {
    env,
    options: {},
    clientVersion: '1.2.3',
    diagnostics: { emit: () => {} },
    createError: (code, message, details) => new AppError(code, message, details),
    runHostCommand: async () => {
      throw new Error('this scenario runs no host commands');
    },
  };
}

test('the plugin declares its provider, capabilities, and no credential variables', () => {
  const plugin = awsDeviceFarm();
  assert.equal(plugin.apiVersion, 3);
  assert.equal(providerOf(plugin).provider, 'aws-device-farm');
  // The AWS CLI credential chain has no environment fingerprint.
  assert.deepEqual(providerOf(plugin).credentials, { variables: [] });
  assert.deepEqual(providerOf(plugin).connection?.capabilities, {
    leaseKind: 'direct-device-provider',
    requiresAppAttachment: true,
    requiresRemoteDaemon: false,
    supportsArtifacts: true,
    supportsDeferredAppSelection: false,
    supportsDirectPortReverse: false,
    usesCloudWebDriverLease: true,
  });
});

test('setup builds a runtime and platform owner for AWS Device Farm', async () => {
  const setup = await providerOf(awsDeviceFarm()).setup(host());
  assert.ok('runtime' in setup);
  const { runtime, platformModule } = setup;
  try {
    assert.equal(runtime.provider, 'aws-device-farm');
    assert.equal(platformModule.owner.provider, 'aws-device-farm');
  } finally {
    await runtime.shutdown();
  }
});

test('lease preparation reads the connect selectors before any host command runs', async () => {
  const setup = await providerOf(awsDeviceFarm()).setup(host());
  assert.ok('runtime' in setup);
  const { runtime } = setup;
  const lease: DeviceLease = {
    leaseId: 'lease-aws',
    tenantId: 'team-a',
    runId: 'run-a',
    leaseProvider: 'aws-device-farm',
    backend: 'android-instance',
    createdAt: 1,
    expiresAt: 2,
    heartbeatAt: 1,
  };
  try {
    await assert.rejects(
      (runtime as ProviderDeviceRuntime).leaseLifecycle.allocate!(lease, {
        flags: { platform: 'android', awsDeviceArn: DEVICE_ARN },
      }),
      {
        code: 'INVALID_ARGS',
        message: 'AWS Device Farm requires --aws-project-arn <arn> or AWS_DEVICE_FARM_PROJECT_ARN.',
      },
    );
  } finally {
    await runtime.shutdown();
  }
});

test('artifact lookup runs in the region of the session ARN, not the environment region', async () => {
  const commands: string[][] = [];
  const options = createAwsDeviceFarmWebDriver({
    ...host({ AWS_REGION: 'eu-west-1' }),
    runHostCommand: async (command, args) => {
      commands.push([command, ...args]);
      return { stdout: '{"artifacts":[]}' };
    },
  });

  await options.listArtifacts!({
    provider: 'aws-device-farm',
    providerSessionId: 'arn:aws:devicefarm:us-west-2:123:session:project-a/session-a/00000',
  });

  // One lookup each for the FILE and LOG artifacts.
  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.equal(command[command.indexOf('--region') + 1], 'us-west-2', command.join(' '));
  }
});

test('the factory connects through the lazy callbacks', async () => {
  const connection = providerOf(awsDeviceFarm()).connection!;
  const { profile } = await connection.resolve({
    flags: {
      json: false,
      help: false,
      version: false,
      platform: 'android',
      awsProjectArn: 'arn:aws:devicefarm:us-west-2:123:project:project-a',
      awsDeviceArn: DEVICE_ARN,
    },
    stateDir: '/state',
    cwd: '/',
    env: {},
    host: host({ AWS_REGION: 'eu-west-1' }),
  });
  assert.equal(profile.leaseProvider, 'aws-device-farm');
  assert.equal(profile.awsRegion, 'eu-west-1');
});
