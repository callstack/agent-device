import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import type { CloudAttachment } from './cloud-attachment-schema.ts';
import { writeCloudAttachment } from './cloud-attachment.ts';
import {
  cleanExpiredCloudAttachments,
  cloudAttachmentPath,
  readCloudConnection,
  writeCloudConnection,
  type ConnectionLocation,
} from './cloud-connection-record.ts';

test('unreadable cloud state keeps a typed I/O code without exposing the local error', () => {
  const stateDir = mkdtempForTestSync('cloud-record-unreadable-');
  const original = fs.lstatSync;
  const lstat = vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
    if (String(args[0]).startsWith(stateDir)) {
      throw Object.assign(new Error('private state details'), { code: 'EACCES' });
    }
    return Reflect.apply(original, fs, args);
  });
  try {
    const error = expect(() => readCloudConnection({ stateDir, session: 'fixture' }));
    error.toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'cloud_connection_record_unreadable',
          recordReadCode: 'EACCES',
        }),
      }),
    );
    error.not.toThrow(/private state details/);
  } finally {
    lstat.mockRestore();
  }
});

const proxyFrontAttachment = {
  kind: 'agent-device-daemon',
  daemonBaseUrl: 'https://daemon.example/device',
  daemonAuthToken: 'scoped-daemon-token',
  leasing: 'proxy-front',
};

function expiredProxyFrontLocation(): ConnectionLocation {
  const stateDir = mkdtempForTestSync('cloud-record-expiry-');
  const location = { stateDir, session: 'expiry-qa' };
  writeCloudConnection(location, {
    session: location.session,
    generation: 'generation-1',
    phase: 'committed',
    origin: 'https://cloud.example',
    fingerprint: 'fingerprint-1',
    id: '00000000-0000-4000-8000-000000000001',
    deadlineAt: new Date(Date.now() - 1000).toISOString(),
  });
  writeCloudAttachment(location, proxyFrontAttachment as CloudAttachment);
  return location;
}

test('an expired proxy front is released with its attachment before the attachment is removed', async () => {
  const location = expiredProxyFrontLocation();
  const released: unknown[] = [];
  await cleanExpiredCloudAttachments(
    location.stateDir,
    async () => {
      throw new Error('a limrun daemon is not retired for a proxy front');
    },
    async (_location, attachment) => {
      expect(fs.existsSync(cloudAttachmentPath(location))).toBe(true);
      released.push(attachment);
    },
  );
  expect(released).toEqual([proxyFrontAttachment]);
  expect(fs.existsSync(cloudAttachmentPath(location))).toBe(false);
});

test('an expired proxy-front attachment is removed even when its release fails', async () => {
  const location = expiredProxyFrontLocation();
  const attempts: unknown[] = [];
  await cleanExpiredCloudAttachments(
    location.stateDir,
    async () => undefined,
    async (_location, attachment) => {
      attempts.push(attachment);
      throw new Error('the front did not confirm the release');
    },
  );
  expect(attempts).toEqual([proxyFrontAttachment]);
  expect(fs.existsSync(cloudAttachmentPath(location))).toBe(false);
});
