import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

export const provider = 'aws-device-farm';
export const primaryExport = {
  types: './dist/agent-device.d.mts',
  import: './dist/agent-device.mjs',
};
export const additionalExports = {
  './connection-verification': {
    types: './dist/connection-verification.d.mts',
    import: './dist/connection-verification.mjs',
  },
  './package.json': './package.json',
};
export const args = [
  '--platform',
  'android',
  '--aws-project-arn',
  'arn:aws:devicefarm:us-west-2:123456789012:project:12345678-1111-2222-3333-456789abcdef',
  '--aws-device-arn',
  'arn:aws:devicefarm:us-west-2::device:12345678-1111-2222-3333-456789abcdef',
  '--aws-app-arn',
  'arn:aws:devicefarm:us-west-2:123456789012:upload:12345678-1111-2222-3333-456789abcdef/12345678-1111-2222-3333-456789abcdef',
];

const RESOURCES = {
  'get-project': { project: { arn: 'project', name: 'Agent Device' } },
  'get-device': {
    device: {
      arn: 'device',
      name: 'Google Pixel 8',
      platform: 'ANDROID',
      os: '14',
      availability: 'HIGHLY_AVAILABLE',
    },
  },
  'get-upload': {
    upload: {
      arn: 'upload',
      name: 'sample.apk',
      type: 'ANDROID_APP',
      status: 'SUCCEEDED',
    },
  },
};

// The AWS CLI is the plugin's only external call, so the fixture answers it from PATH. It has no
// credentials of its own to reject, so `connect` must pass on its first try.
export function environment(endpoint) {
  void endpoint;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-aws-fixture-'));
  const script = [
    '#!/usr/bin/env node',
    `const resources = ${JSON.stringify(RESOURCES)};`,
    'const subcommand = process.argv[3];',
    'const result = resources[subcommand];',
    'if (!result) {',
    '  process.stderr.write(`unexpected aws devicefarm ${subcommand}\\n`);',
    '  process.exit(1);',
    '}',
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'aws'), script, 'utf8');
  fs.chmodSync(path.join(bin, 'aws'), 0o755);
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
}

export async function verifyPacked({ core, contracts, plugin }) {
  const flags = {
    platform: 'android',
    awsProjectArn: 'arn:aws:devicefarm:us-west-2:123:project:project',
    awsDeviceArn: 'arn:aws:devicefarm:us-west-2::device:device',
    awsAppArn: 'arn:aws:devicefarm:us-west-2:123:upload:upload',
  };
  const calls = [];
  const host = {
    env: {},
    options: {},
    clientVersion: '0.22.0',
    createError: (code, message, details) => new core.AppError(code, message, details),
    runHostCommand: async (_command, commandArgs) => {
      const subcommand = commandArgs[1];
      calls.push(subcommand);
      if (subcommand === 'get-project') return { stdout: JSON.stringify(RESOURCES[subcommand]) };
      if (subcommand === 'get-device') return { stdout: JSON.stringify(RESOURCES[subcommand]) };
      if (subcommand === 'get-upload') {
        return { stdout: JSON.stringify({ upload: { status: 'PROCESSING' } }) };
      }
      if (subcommand === 'create-remote-access-session') {
        return { stdout: JSON.stringify({ remoteAccessSession: { arn: 'session-arn' } }) };
      }
      if (subcommand === 'get-remote-access-session') {
        throw new core.AppError('COMMAND_FAILED', 'host command failed', {
          reason: 'host-primary',
          hint: 'Retry manually.',
        });
      }
      if (subcommand === 'stop-remote-access-session') {
        throw new core.AppError('COMMAND_FAILED', 'cleanup failed', { reason: 'cleanup-failed' });
      }
      throw new Error(`Unexpected AWS command: ${subcommand}`);
    },
  };
  const aws = plugin.default();
  const capture = async (run) => {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof core.AppError);
      return contracts.normalizeError(error);
    }
    assert.fail('Expected an AWS failure');
  };
  const missing = await capture(() =>
    aws.connection.resolve({ flags: { platform: 'android' }, cwd: '/', env: {}, host }),
  );
  assert.equal(missing.code, 'INVALID_ARGS');
  assert.ok(missing.hint);

  const verification = await capture(() => aws.connection.verify({ flags, env: {}, host }));
  assert.equal(verification.code, 'COMMAND_FAILED');
  assert.equal(verification.details.status, 'PROCESSING');
  assert.equal(
    verification.hint,
    'Wait for the upload to succeed or reconnect with a different --aws-app-arn.',
  );

  const setup = await aws.setup(host);
  const allocation = await capture(() =>
    setup.webDriver.prepareSession({
      lease: { leaseId: 'lease-1' },
      req: { flags },
      base: {
        provider,
        platform: 'android',
        deviceName: 'device',
        endpoint: 'http://localhost',
        webdriverCapabilities: {},
      },
    }),
  );
  assert.equal(allocation.code, 'COMMAND_FAILED');
  assert.equal(allocation.details.reason, 'host-primary');
  assert.equal(allocation.hint, 'Retry manually.');
  assert.equal(allocation.details.cleanupError, 'cleanup failed');
  assert.deepEqual(calls.slice(-3), [
    'create-remote-access-session',
    'get-remote-access-session',
    'stop-remote-access-session',
  ]);
}

export async function verifyTypes({ consumer, run, root }) {
  fs.writeFileSync(
    path.join(consumer, 'consumer.mts'),
    `
import { startAgentDevice } from 'agent-device';
import awsDeviceFarm from '@agent-device/aws-device-farm/agent-device';
import { verifyAwsDeviceFarmConnection } from '@agent-device/aws-device-farm/connection-verification';
const runtime = await startAgentDevice({ stateDir: './state', plugins: [awsDeviceFarm()] });
await runtime.close();
await verifyAwsDeviceFarmConnection({ platform: 'android', projectArn: 'project', deviceArn: 'device' }, async () => ({ stdout: '{}' }));
`,
  );
  await run(
    process.execPath,
    [
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--typeRoots',
      path.join(root, 'node_modules/@types'),
      'consumer.mts',
    ],
    consumer,
  );
}
