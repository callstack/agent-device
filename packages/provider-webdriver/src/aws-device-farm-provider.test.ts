import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { awsDeviceFarmProvider } from './aws-device-farm-provider.ts';
import type { CloudWebDriverProviderHost } from './provider-plugin.ts';

const DEVICE_ARN = 'arn:aws:devicefarm:us-west-2::device:device-a';

function host(env: Record<string, string | undefined> = {}): CloudWebDriverProviderHost {
  return {
    env,
    clientVersion: '1.2.3',
    runHostCommand: async () => {
      throw new Error('this scenario runs no host commands');
    },
  };
}

test('the declaration reserves the provider id without environment credentials', () => {
  assert.equal(awsDeviceFarmProvider.declaration.provider, 'aws-device-farm');
  assert.equal(awsDeviceFarmProvider.declaration.credentialVariables, undefined);
  assert.equal(awsDeviceFarmProvider.declaration.connection.requiresAppAttachment, true);
});

test('lease preparation reads the connect selectors before any host command runs', async () => {
  const { webDriver } = awsDeviceFarmProvider.create(host());
  assert.equal(webDriver.profileFields.provider, 'aws-device-farm');
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
  await assert.rejects(
    webDriver.prepareSession!({
      lease,
      req: { flags: { platform: 'android', awsDeviceArn: DEVICE_ARN } },
      base: {
        provider: 'aws-device-farm',
        endpoint: 'http://127.0.0.1/',
        platform: 'android',
        deviceName: 'AWS Device Farm device',
        webdriverCapabilities: {},
      },
    }),
    {
      code: 'INVALID_ARGS',
      message: 'AWS Device Farm requires --aws-project-arn <arn> or AWS_DEVICE_FARM_PROJECT_ARN.',
    },
  );
});

test('the factory connects through the lazy callbacks', async () => {
  const { connection } = awsDeviceFarmProvider.create(host({ AWS_REGION: 'eu-west-1' }));
  const { profile } = await connection.resolve({
    flags: {
      json: false,
      help: false,
      version: false,
      platform: 'android',
      awsProjectArn: 'arn:aws:devicefarm:us-west-2:123:project:project-a',
      awsDeviceArn: DEVICE_ARN,
    },
    cwd: '/',
  });
  assert.equal(profile.leaseProvider, 'aws-device-farm');
  assert.equal(profile.awsRegion, 'eu-west-1');
});
