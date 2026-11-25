import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { readCloudConnection } from './cloud-connection-record.ts';

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
