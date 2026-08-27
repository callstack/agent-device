import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  ArchiveBudget,
  normalizeArchiveEntryName,
  resolveArchiveOutputPath,
} from './archive-safety.ts';

function reason(error: unknown): string | undefined {
  return error instanceof AppError ? (error.details?.reason as string | undefined) : undefined;
}

test('archive paths normalize within the output root', () => {
  assert.equal(
    normalizeArchiveEntryName('./Payload/App.app/Info.plist'),
    'Payload/App.app/Info.plist',
  );
  assert.equal(
    resolveArchiveOutputPath('/tmp/archive-root', 'Payload/App.app/Info.plist'),
    '/tmp/archive-root/Payload/App.app/Info.plist',
  );
});

test('archive paths reject absolute, escaping, drive, UNC, NUL, and backslash forms', () => {
  for (const entry of [
    '/absolute',
    '../escape',
    'safe/../../escape',
    'C:/drive',
    '//server/share',
    'safe\\windows',
    'nul\0entry',
    '.',
  ]) {
    assert.throws(
      () => normalizeArchiveEntryName(entry),
      (error) => reason(error) === 'ARCHIVE_UNSAFE_PATH',
      entry,
    );
  }
});

test('archive budget preflight is non-consuming and cumulative charges are bounded', () => {
  const budget = new ArchiveBudget({ maxBytes: 5, maxEntries: 2, maxDepth: 2 });
  const reservation = budget.preflightArchive({ depth: 1, entryCount: 1, declaredBytes: 3 });
  assert.equal(budget.bytes, 0);
  assert.equal(budget.entries, 0);

  reservation.chargeBytes(3);
  reservation.commitEntry();
  reservation.finish();
  assert.equal(budget.bytes, 3);
  assert.equal(budget.entries, 1);

  assert.throws(
    () => budget.preflightArchive({ depth: 2, entryCount: 1, declaredBytes: 3 }),
    (error) => reason(error) === 'ARCHIVE_EXPANDED_BYTES_LIMIT',
  );
  assert.throws(
    () => budget.preflightArchive({ depth: 3, entryCount: 0, declaredBytes: 0 }),
    (error) => reason(error) === 'ARCHIVE_NESTING_LIMIT',
  );
});

test('archive reservation rejects bytes or entries beyond its inspected manifest', () => {
  const bytes = new ArchiveBudget({ maxBytes: 10, maxEntries: 2 });
  const byteReservation = bytes.preflightArchive({ depth: 1, entryCount: 1, declaredBytes: 2 });
  assert.throws(
    () => byteReservation.chargeBytes(3),
    (error) => reason(error) === 'ARCHIVE_MANIFEST_MISMATCH',
  );

  const entries = new ArchiveBudget({ maxBytes: 10, maxEntries: 2 });
  const entryReservation = entries.preflightArchive({ depth: 1, entryCount: 1, declaredBytes: 0 });
  entryReservation.commitEntry();
  assert.throws(
    () => entryReservation.commitEntry(),
    (error) => reason(error) === 'ARCHIVE_MANIFEST_MISMATCH',
  );
});
