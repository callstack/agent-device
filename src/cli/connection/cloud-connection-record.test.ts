import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { PrivateDirectoryInitializingError } from '@agent-device/host-kit/file';
import { FOREIGN_UID, mkdtempForTestSync, serveHostOwnership } from '@agent-device/test-kit';
import { writeCloudAttachment } from './cloud-attachment.ts';
import {
  cloudConnectionDir,
  prepareCloudConnection,
  readCloudConnection,
  tryWithConnectionLock,
  withConnectionLock,
  writeCloudConnection,
} from './cloud-connection-record.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

function sampleRecord(session: string) {
  return prepareCloudConnection(
    session,
    {
      platform: 'ios',
      accepts: ['agent-device-daemon'],
      vendor: undefined,
      maxMinutes: undefined,
    },
    'https://cloud.example',
    null,
  );
}

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

test('writeCloudConnection creates a missing nested state root cleanly', () => {
  const stateDir = path.join(mkdtempForTestSync('cloud-record-fresh-write-'), 'nested', 'state');
  const location = { stateDir, session: 'fresh-write' };
  const record = sampleRecord(location.session);
  writeCloudConnection(location, record);
  expect(readCloudConnection({ stateDir, session: 'other-session' })).toBeNull();
  const written = JSON.parse(
    fs.readFileSync(path.join(cloudConnectionDir(location), 'record.json'), 'utf8'),
  );
  expect(written).toEqual(record);
});

test.skipIf(process.platform === 'win32')(
  'withConnectionLock, tryWithConnectionLock, and writeCloudConnection create a fresh state root at 0o700 under umask 002',
  async () => {
    const previousUmask = process.umask(0o002);
    try {
      const lockStateDir = path.join(mkdtempForTestSync('cloud-umask-lock-'), 'state');
      const lockLocation = { stateDir: lockStateDir, session: 'umask-lock' };
      const record = sampleRecord(lockLocation.session);
      const read = await withConnectionLock(lockStateDir, lockLocation.session, async () => {
        expect(readCloudConnection(lockLocation)).toBeNull();
        writeCloudConnection(lockLocation, record);
        return readCloudConnection(lockLocation);
      });
      expect(read).toEqual(record);
      expect(fs.statSync(lockStateDir).mode & 0o777).toBe(0o700);

      const tryStateDir = path.join(mkdtempForTestSync('cloud-umask-try-'), 'state');
      const tryLocation = { stateDir: tryStateDir, session: 'umask-try' };
      await tryWithConnectionLock(tryLocation, () => {
        expect(readCloudConnection(tryLocation)).toBeNull();
      });
      expect(fs.statSync(tryStateDir).mode & 0o777).toBe(0o700);

      const writeStateDir = path.join(mkdtempForTestSync('cloud-umask-write-'), 'state');
      const writeLocation = { stateDir: writeStateDir, session: 'umask-write' };
      writeCloudConnection(writeLocation, sampleRecord(writeLocation.session));
      expect(fs.statSync(writeStateDir).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previousUmask);
    }
  },
);

test.skipIf(process.platform === 'win32').each([0o775, 0o777])(
  'pre-existing state root with unsafe mode %o stays unmodified and is rejected by cloud admission',
  async (mode) => {
    const stateDir = path.join(mkdtempForTestSync('cloud-unsafe-existing-'), 'state');
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.chmodSync(stateDir, mode);
    const location = { stateDir, session: 'unsafe-existing' };

    await expect(
      withConnectionLock(stateDir, location.session, async () => readCloudConnection(location)),
    ).rejects.toMatchObject({
      details: { reason: 'cloud_credential_store_unsafe' },
    });
    expect(fs.statSync(stateDir).mode & 0o777).toBe(mode);
    expect(() => writeCloudConnection(location, sampleRecord(location.session))).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'cloud_credential_store_unsafe' }),
      }),
    );
  },
);

test.skipIf(process.platform === 'win32')(
  'pre-existing state root owned by another user is still rejected by cloud admission',
  async () => {
    const stateDir = mkdtempForTestSync('cloud-foreign-existing-');
    serveHostOwnership({ [stateDir]: FOREIGN_UID });
    const location = { stateDir, session: 'foreign-existing' };

    await expect(
      withConnectionLock(stateDir, location.session, async () => readCloudConnection(location)),
    ).rejects.toMatchObject({
      details: { reason: 'cloud_credential_store_unsafe' },
    });
    expect(() => writeCloudConnection(location, sampleRecord(location.session))).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'cloud_credential_store_unsafe' }),
      }),
    );
  },
);

test('locked writeCloudConnection refuses without recreating a vanished or replaced state root', async () => {
  const parent = mkdtempForTestSync('cloud-locked-vanished-');
  const stateDir = path.join(parent, 'state');
  const location = { stateDir, session: 'locked-vanished' };
  const record = sampleRecord(location.session);

  await expect(
    withConnectionLock(stateDir, location.session, async () => {
      fs.rmSync(stateDir, { recursive: true, force: true });
      writeCloudConnection(location, record);
    }),
  ).rejects.toMatchObject({
    details: { reason: 'cloud_credential_store_unsafe' },
  });
  expect(fs.existsSync(stateDir)).toBe(false);

  await expect(
    withConnectionLock(stateDir, location.session, async () => {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.mkdirSync(stateDir, { mode: 0o700 });
      writeCloudConnection(location, record);
    }),
  ).rejects.toMatchObject({
    details: { reason: 'cloud_credential_store_unsafe' },
  });
});

test('tryWithConnectionLock refuses without recreating a state root that vanished before lock acquisition', async () => {
  const parent = mkdtempForTestSync('cloud-try-lock-vanished-');
  const stateDir = path.join(parent, 'state');
  const location = { stateDir, session: 'try-vanished' };
  const originalOpen = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (String(args[0]).endsWith('.reclaim.lock')) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    return Reflect.apply(originalOpen, fs, args);
  });

  await expect(tryWithConnectionLock(location, () => {})).rejects.toMatchObject({
    details: { reason: 'cloud_credential_store_unsafe' },
  });
  expect(fs.existsSync(stateDir)).toBe(false);
});

test.skipIf(process.platform === 'win32')(
  'cloud admission refuses a symlink state root pointing to an owned 0o700 directory',
  async () => {
    const parent = mkdtempForTestSync('cloud-symlink-root-');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.chmodSync(outside, 0o700);
    const link = path.join(parent, 'state-link');
    fs.symlinkSync(outside, link);
    const location = { stateDir: link, session: 'symlink-root' };

    await expect(
      withConnectionLock(link, location.session, async () => readCloudConnection(location)),
    ).rejects.toMatchObject({
      details: { reason: 'cloud_credential_store_unsafe' },
    });
    expect(() => writeCloudConnection(location, sampleRecord(location.session))).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'cloud_credential_store_unsafe' }),
      }),
    );
  },
);

test('locked writeCloudAttachment refuses without recreating a vanished state root', async () => {
  const parent = mkdtempForTestSync('cloud-attachment-locked-vanished-');
  const stateDir = path.join(parent, 'state');
  const location = { stateDir, session: 'locked-attachment-vanished' };

  await expect(
    withConnectionLock(stateDir, location.session, async () => {
      fs.rmSync(stateDir, { recursive: true, force: true });
      writeCloudAttachment(location, {
        kind: 'agent-device-daemon',
        daemonBaseUrl: 'https://daemon.example',
        daemonAuthToken: 'secret-token',
      });
    }),
  ).rejects.toMatchObject({
    details: { reason: 'cloud_credential_store_unsafe' },
  });
  expect(fs.existsSync(stateDir)).toBe(false);
});

test.skipIf(process.platform === 'win32')(
  'readCloudConnection waits and throws retriable PrivateDirectoryInitializingError if an unfinished 0o500 subdirectory stays unready',
  () => {
    const stateDir = path.join(mkdtempForTestSync('cloud-subdir-init-'), 'state');
    const location = { stateDir, session: 'initializing-subdir' };
    const connDir = cloudConnectionDir(location);
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.chmodSync(stateDir, 0o700);
    fs.mkdirSync(path.dirname(connDir), { mode: 0o700 });
    fs.chmodSync(path.dirname(connDir), 0o700);
    fs.mkdirSync(connDir, { mode: 0o500 });
    fs.chmodSync(connDir, 0o500);

    try {
      expect(() => readCloudConnection(location)).toThrow(PrivateDirectoryInitializingError);
    } finally {
      fs.chmodSync(connDir, 0o700);
    }
  },
);
