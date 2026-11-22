import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { PluginConnectionContext, ProviderPluginHost } from 'agent-device/plugins';
import { AppError } from '@agent-device/kernel/errors';
import { createAwsDeviceFarmConnection } from './connection.ts';
import { verifyAwsDeviceFarmConnection } from './aws-device-farm-connection-verification.ts';

vi.mock('./aws-device-farm-connection-verification.ts', () => ({
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

function context(
  overrides: Partial<PluginConnectionContext> & { flags?: Record<string, unknown> } = {},
): PluginConnectionContext {
  const pluginHost = overrides.host ?? host();
  return {
    flags: FLAGS,
    stateDir: '/state',
    cwd: '/',
    env: { ...pluginHost.env },
    host: pluginHost,
    ...overrides,
  } as PluginConnectionContext;
}

test('connect resolves selectors from flags, then agent-device variables, then AWS variables', async () => {
  const connection = createAwsDeviceFarmConnection(
    host({
      AWS_DEVICE_FARM_APP_ARN: 'arn:app',
      AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN: 'arn:app-preferred',
      AWS_DEFAULT_REGION: 'eu-west-1',
    }),
  );
  const { profile } = await connection.resolve(context());
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
  const fromArn = await createAwsDeviceFarmConnection(host()).resolve(context());
  assert.equal(fromArn.profile.awsRegion, 'us-west-2');
});

test('connect names the flag and the AWS variable a missing selector can come from', async () => {
  const connection = createAwsDeviceFarmConnection(host());
  await assert.rejects(
    async () => await connection.resolve(context({ flags: { ...FLAGS, awsDeviceArn: undefined } })),
    {
      code: 'INVALID_ARGS',
      message:
        'connect aws-device-farm requires --aws-device-arn <arn> or AWS_DEVICE_FARM_DEVICE_ARN.',
    },
  );
  await assert.rejects(
    async () => await connection.resolve(context({ flags: { ...FLAGS, providerApp: 'app.ipa' } })),
    (error: unknown) =>
      error instanceof AppError && JSON.stringify(error.details?.flags) === '["--provider-app"]',
  );
});

test('verify hands the saved selectors and a host-command runner to the verifier', async () => {
  const calls: string[][] = [];
  const providerHost = {
    ...host(),
    runHostCommand: async (command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      return { stdout: '{}' };
    },
  };
  const connection = createAwsDeviceFarmConnection(providerHost);
  await connection.verify({ flags: { ...FLAGS, awsRegion: 'us-west-2' } });
  const [options, runHostCommand] = vi.mocked(verifyAwsDeviceFarmConnection).mock.calls[0]!;
  assert.deepEqual(options, {
    platform: 'ios',
    projectArn: PROJECT_ARN,
    deviceArn: DEVICE_ARN,
    appArn: undefined,
    region: 'us-west-2',
  });
  // The verifier drives the AWS CLI through the host capability, with the plugin host's own bounds.
  await runHostCommand('aws', ['devicefarm', 'get-project', '--arn', PROJECT_ARN]);
  assert.deepEqual(calls, [['aws', 'devicefarm', 'get-project', '--arn', PROJECT_ARN]]);
  await assert.rejects(connection.verify({ flags: { ...FLAGS, platform: undefined } }), {
    code: 'COMMAND_FAILED',
    message: 'AWS Device Farm profile missed a mobile platform.',
  });
});
