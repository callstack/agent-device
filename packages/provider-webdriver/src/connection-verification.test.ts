import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { verifyAwsDeviceFarmConnection } from './connection-verification.ts';
import type { RunHostCommand } from './dependencies.ts';

const awsResources = {
  project: { arn: 'project-arn', name: 'Agent Device' },
  device: {
    arn: 'device-arn',
    name: 'Google Pixel 8',
    platform: 'ANDROID',
    os: '14',
    availability: 'HIGHLY_AVAILABLE',
  },
  upload: {
    arn: 'app-arn',
    name: 'sample.apk',
    type: 'ANDROID_APP',
    status: 'SUCCEEDED',
  },
};

afterEach(() => vi.unstubAllGlobals());

test('AWS Device Farm verifies resources without creating a remote access session', async () => {
  const concurrency = { active: 0, max: 0 };
  const runHostCommand = createAwsRunner(awsResources, concurrency);
  const result = await verifyAwsDeviceFarmConnection(
    {
      platform: 'android',
      projectArn: 'project-arn',
      deviceArn: 'device-arn',
      appArn: 'app-arn',
      region: 'us-west-2',
    },
    runHostCommand,
  );

  assert.equal(result.provider, 'aws-device-farm');
  if (result.provider !== 'aws-device-farm') return;
  assert.deepEqual(result.project, { name: 'Agent Device', reference: 'project-arn' });
  assert.equal(result.device.name, 'Google Pixel 8');
  assert.equal(result.app.name, 'sample.apk');
  assert.deepEqual(
    runHostCommand.mock.calls.map(([, args]) => args[1]),
    ['get-project', 'get-device', 'get-upload'],
  );
  assert.equal(
    runHostCommand.mock.calls.some(([, args]) => args.includes('create-remote-access-session')),
    false,
  );
  assert.equal(concurrency.max, 3);
});

test('AWS Device Farm reports an unattached app without pretending it is installed', async () => {
  const runHostCommand = createAwsRunner({
    project: awsResources.project,
    device: { ...awsResources.device, platform: 'IOS', name: 'iPhone 15', os: '17' },
  });
  const result = await verifyAwsDeviceFarmConnection(
    {
      platform: 'ios',
      projectArn: 'project-arn',
      deviceArn: 'device-arn',
    },
    runHostCommand,
  );

  assert.equal(result.app.status, 'missing');
  assert.match(result.app.message ?? '', /--aws-app-arn/);
  assert.equal(runHostCommand.mock.calls.length, 2);
});

test('AWS Device Farm rejects a device from the wrong platform before allocation', async () => {
  const runHostCommand = createAwsRunner({
    project: awsResources.project,
    device: { ...awsResources.device, platform: 'IOS', name: 'iPhone 15', os: '17' },
  });

  await assert.rejects(
    verifyAwsDeviceFarmConnection(
      {
        platform: 'android',
        projectArn: 'project-arn',
        deviceArn: 'device-arn',
      },
      runHostCommand,
    ),
    /is ios, not android/,
  );
  assert.equal(
    runHostCommand.mock.calls.some(([, args]) => args.includes('create-remote-access-session')),
    false,
  );
});

function createAwsRunner(
  resources: Partial<typeof awsResources>,
  concurrency?: { active: number; max: number },
) {
  return vi.fn<RunHostCommand>(async (_command, args) => {
    if (concurrency) {
      concurrency.active += 1;
      concurrency.max = Math.max(concurrency.max, concurrency.active);
    }
    await Promise.resolve();
    try {
      const resource = resources[String(args[1]).replace('get-', '') as keyof typeof awsResources];
      if (!resource) throw new Error(`Unexpected AWS command: ${args[1]}`);
      return { stdout: JSON.stringify({ [String(args[1]).replace('get-', '')]: resource }) };
    } finally {
      if (concurrency) concurrency.active -= 1;
    }
  });
}
