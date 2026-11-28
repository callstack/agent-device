import { expect, test } from 'vitest';
import { parseCloudAttachment } from './cloud-attachment-schema.ts';

const daemon = {
  kind: 'agent-device-daemon',
  daemonBaseUrl: 'https://daemon.example/device',
  daemonAuthToken: 'scoped-daemon-token',
};

test('a daemon attachment without the leasing field parses with no leasing', () => {
  const parsed = parseCloudAttachment(daemon);
  expect(parsed).toEqual(daemon);
  expect(parsed).not.toHaveProperty('leasing');
});

test('a daemon attachment that names a proxy front keeps the leasing field', () => {
  expect(parseCloudAttachment({ ...daemon, leasing: 'proxy-front' })).toEqual({
    ...daemon,
    leasing: 'proxy-front',
  });
});

test('a daemon attachment with an unknown leasing value is refused', () => {
  expect(parseCloudAttachment({ ...daemon, leasing: 'everything' })).toBeUndefined();
  expect(parseCloudAttachment({ ...daemon, leasing: '' })).toBeUndefined();
});
