import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createAwsDeviceFarmConnection } from './aws-device-farm-connection.ts';
import { verifyAwsDeviceFarmConnection } from './connection-verification.ts';
import type { CloudWebDriverProviderHost } from './provider-plugin.ts';

vi.mock('./connection-verification.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./connection-verification.ts')>()),
  verifyAwsDeviceFarmConnection: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

const PROJECT_ARN = 'arn:aws:devicefarm:us-west-2:123:project:project-a';
const DEVICE_ARN = 'arn:aws:devicefarm:us-west-2::device:device-a';
const FLAGS = {
  json: false,
  help: false,
  version: false,
  platform: 'ios' as const,
  awsProjectArn: PROJECT_ARN,
  awsDeviceArn: DEVICE_ARN,
};

function host(env: Record<string, string | undefined> = {}): CloudWebDriverProviderHost {
  return {
    env,
    clientVersion: '1.2.3',
    runHostCommand: async () => {
      throw new Error('this scenario runs no host commands');
    },
  };
}

test('connect resolves selectors from flags, then agent-device variables, then AWS variables', async () => {
  const connection = createAwsDeviceFarmConnection(
    host({
      AWS_DEVICE_FARM_APP_ARN: 'arn:app',
      AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN: 'arn:app-preferred',
      AWS_DEFAULT_REGION: 'eu-west-1',
    }),
  );
  const { profile, extraFlags } = connection.resolve({ flags: FLAGS, cwd: '/' });
  assert.equal(extraFlags, undefined);
  assert.deepEqual(profile, {
    leaseProvider: 'aws-device-farm',
    platform: 'ios',
    device: undefined,
    awsProjectArn: PROJECT_ARN,
    awsDeviceArn: DEVICE_ARN,
    awsAppArn: 'arn:app-preferred',
    awsRegion: 'eu-west-1',
    awsInteractionMode: undefined,
    providerSessionName: undefined,
  });
  // With no region configured, the project ARN names it.
  const fromArn = createAwsDeviceFarmConnection(host()).resolve({ flags: FLAGS, cwd: '/' });
  assert.equal(fromArn.profile.awsRegion, 'us-west-2');
});

test('connect names the flag and the AWS variable a missing selector can come from', async () => {
  const connection = createAwsDeviceFarmConnection(host());
  assert.throws(
    () => connection.resolve({ flags: { ...FLAGS, awsDeviceArn: undefined }, cwd: '/' }),
    {
      code: 'INVALID_ARGS',
      message:
        'connect aws-device-farm requires --aws-device-arn <arn> or AWS_DEVICE_FARM_DEVICE_ARN.',
    },
  );
  assert.throws(
    () => connection.resolve({ flags: { ...FLAGS, providerApp: 'app.ipa' }, cwd: '/' }),
    (error: unknown) =>
      error instanceof AppError && JSON.stringify(error.details?.flags) === '["--provider-app"]',
  );
});

test('verify hands the saved selectors and the host command runner to the verifier', async () => {
  const providerHost = host();
  const connection = createAwsDeviceFarmConnection(providerHost);
  await connection.verify({ flags: { ...FLAGS, awsRegion: 'us-west-2' } });
  assert.deepEqual(vi.mocked(verifyAwsDeviceFarmConnection).mock.calls[0], [
    {
      platform: 'ios',
      projectArn: PROJECT_ARN,
      deviceArn: DEVICE_ARN,
      appArn: undefined,
      region: 'us-west-2',
    },
    providerHost.runHostCommand,
  ]);
  await assert.rejects(connection.verify({ flags: { ...FLAGS, platform: undefined } }), {
    code: 'COMMAND_FAILED',
    message: 'AWS Device Farm profile missed a mobile platform.',
  });
});
