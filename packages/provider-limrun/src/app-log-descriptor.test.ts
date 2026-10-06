import { expect, test } from 'vitest';
import { limrunAppLogDescriptorCodec } from './app-log-descriptor.ts';

const body = {
  transport: 'limrun-log-poller',
  platform: 'ios',
  leaseId: 'lease-a',
  instanceId: 'ios_instance',
  appBundleId: 'com.example.app',
  outputPath: '/sessions/one/app.log',
};

test('decodes descriptors written before ownership as created instances', () => {
  expect(limrunAppLogDescriptorCodec.decode(body)).toMatchObject({
    status: 'decoded',
    descriptor: { ownership: 'created' },
  });
  expect(limrunAppLogDescriptorCodec.decode({ ...body, ownership: 'attached' })).toMatchObject({
    status: 'decoded',
    descriptor: { ownership: 'attached' },
  });
  expect(limrunAppLogDescriptorCodec.decode({ ...body, ownership: 'borrowed' }).status).toBe(
    'invalid',
  );
});
