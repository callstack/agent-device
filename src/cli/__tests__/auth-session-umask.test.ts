import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { readCliSession, resolveCliSessionPath, writeCliSession } from '../auth-session.ts';

test.skipIf(process.platform === 'win32')(
  'a CLI session written under an owner-masking umask stays readable by its owner',
  () => {
    const tempRoot = mkdtempForTestSync('agent-device-auth-session-umask-');
    const session = {
      version: 2 as const,
      id: 'session-first',
      cloudBaseUrl: 'https://cloud.example',
      refreshCredential: 'adc_refresh_umask',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    try {
      writeCliSession({ stateDir: tempRoot, session });
      const previousUmask = process.umask(0o700);
      try {
        writeCliSession({ stateDir: tempRoot, session: { ...session, id: 'session-umask' } });
      } finally {
        process.umask(previousUmask);
      }
      assert.equal(fs.statSync(resolveCliSessionPath(tempRoot)).mode & 0o777, 0o600);
      assert.equal(readCliSession({ stateDir: tempRoot })?.id, 'session-umask');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);
