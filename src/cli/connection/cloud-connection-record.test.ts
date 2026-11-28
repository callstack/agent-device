import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import type { CloudAttachment } from './cloud-attachment-schema.ts';
import { writeCloudAttachment } from './cloud-attachment.ts';
import {
  cleanExpiredCloudAttachments,
  cloudAttachmentPath,
  cloudConnectionDir,
  readCloudConnection,
  readProxyFrontAttachment,
  writeCloudConnection,
  type ConnectionLocation,
} from './cloud-connection-record.ts';

test('a missing cloud record is absent even when its credential directory exists', () => {
  const location = { stateDir: mkdtempForTestSync('cloud-record-missing-'), session: 'fixture' };
  expect(readCloudConnection(location)).toBeNull();
  fs.mkdirSync(cloudConnectionDir(location), { recursive: true, mode: 0o700 });
  expect(readCloudConnection(location)).toBeNull();
});

test.each([
  'null',
  'false',
  '0',
  '""',
  '{',
  '{}',
  '{"generation":"g","origin":"https://cloud.example","fingerprint":"f","phase":"pending"}',
])('a private cloud record containing %s is malformed', (contents) => {
  const location = { stateDir: mkdtempForTestSync('cloud-record-malformed-'), session: 'fixture' };
  const directory = cloudConnectionDir(location);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'record.json'), contents, { mode: 0o600 });
  expect(() => readCloudConnection(location)).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'cloud_connection_record_malformed' }),
    }),
  );
});

test('an exposed cloud record has the unsafe credential store outcome', () => {
  const location = { stateDir: mkdtempForTestSync('cloud-record-exposed-'), session: 'fixture' };
  const directory = cloudConnectionDir(location);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'record.json');
  fs.writeFileSync(file, 'null');
  fs.chmodSync(file, 0o644);
  expect(() => readCloudConnection(location)).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'cloud_credential_store_unsafe' }),
    }),
  );
});

test.each(['EACCES', 'EIO'])(
  'unreadable cloud state reports %s without exposing the local error',
  (code) => {
    const stateDir = mkdtempForTestSync('cloud-record-unreadable-');
    const original = fs.lstatSync;
    const lstat = vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
      if (String(args[0]).startsWith(stateDir)) {
        throw Object.assign(new Error('private state details'), { code });
      }
      return Reflect.apply(original, fs, args);
    });
    try {
      const error = expect(() => readCloudConnection({ stateDir, session: 'fixture' }));
      error.toThrow(
        expect.objectContaining({
          details: expect.objectContaining({
            reason: 'cloud_connection_record_unreadable',
            recordReadCode: code,
          }),
        }),
      );
      error.not.toThrow(/private state details/);
    } finally {
      lstat.mockRestore();
    }
  },
);

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

test('reading a proxy-front attachment from an unsafe credential store refuses instead of reading as none', () => {
  const stateDir = mkdtempForTestSync('cloud-record-unsafe-');
  const location = { stateDir, session: 'unsafe-qa' };
  writeCloudAttachment(location, proxyFrontAttachment as CloudAttachment);
  expect(readProxyFrontAttachment(location)).toEqual({
    ...proxyFrontAttachment,
    leasing: 'proxy-front',
  });
  fs.chmodSync(cloudConnectionDir(location), 0o755);
  expect(() => readProxyFrontAttachment(location)).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'cloud_credential_store_unsafe' }),
    }),
  );
});
