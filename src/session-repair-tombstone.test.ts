import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from './__tests__/test-utils/tmp-dir.ts';
import {
  findUnrecoveredRepairCommitFailure,
  readRepairTombstoneFile,
  resolveRepairTombstonePath,
} from './session-repair-tombstone.ts';

function writeRepairTombstone(raw: string) {
  const sessionsDir = mkdtempForTestSync('agent-device-repair-tombstone-');
  const sessionDir = path.join(sessionsDir, 'session-a');
  fs.mkdirSync(sessionDir);
  const tombstonePath = resolveRepairTombstonePath(sessionDir);
  fs.writeFileSync(tombstonePath, raw);
  return { sessionsDir, tombstonePath };
}

function rawRepairTombstone(fields: { reapedAt?: string; sourcePath?: string }): string {
  const entries = [
    '"owner":"session-a"',
    `"expiresAt":${Date.now() + 60_000}`,
    '"commitFailure":{"code":"COMMAND_FAILED","message":"write failed"}',
  ];
  if (fields.reapedAt !== undefined) entries.push(`"reapedAt":${fields.reapedAt}`);
  if (fields.sourcePath !== undefined) entries.push(`"sourcePath":${fields.sourcePath}`);
  return `{${entries.join(',')}}\n`;
}

test.each([
  ['with sourcePath', { sourcePath: '/flows/login.ad' }],
  ['without sourcePath', undefined],
])('cleanup accepts finite reap timestamps %s', (_label, sourcePath) => {
  const reapedAt = Date.now();
  const tombstone = {
    owner: 'session-a',
    reapedAt,
    expiresAt: reapedAt + 60_000,
    ...(sourcePath ?? {}),
    commitFailure: { code: 'COMMAND_FAILED', message: 'write failed' },
  };
  const { sessionsDir, tombstonePath } = writeRepairTombstone(`${JSON.stringify(tombstone)}\n`);

  expect(readRepairTombstoneFile(tombstonePath, 'session-a')).toEqual(tombstone);
  expect(findUnrecoveredRepairCommitFailure(sessionsDir)).toEqual({
    sessionName: 'session-a',
    tombstone,
  });
});

test.each([
  ['missing reapedAt', {}],
  ['string reapedAt', { reapedAt: JSON.stringify('not-a-timestamp') }],
  ['non-finite reapedAt', { reapedAt: '1e400' }],
  ['numeric sourcePath', { reapedAt: String(Date.now()), sourcePath: '7' }],
  ['null sourcePath', { reapedAt: String(Date.now()), sourcePath: 'null' }],
])('malformed %s metadata is rejected and remains on disk', (_label, fields) => {
  const raw = rawRepairTombstone(fields);
  const { sessionsDir, tombstonePath } = writeRepairTombstone(raw);

  expect(readRepairTombstoneFile(tombstonePath, 'session-a')).toBeUndefined();
  assert.throws(
    () => findUnrecoveredRepairCommitFailure(sessionsDir),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'repair_evidence_invalid');
      assert.equal(error.details?.path, tombstonePath);
      return true;
    },
  );
  expect(fs.readFileSync(tombstonePath, 'utf8')).toBe(raw);
});
