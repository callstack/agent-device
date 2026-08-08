import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { extractTarArchive } from '../archive-extraction-tar.ts';
import { ArchiveBudget } from '../archive-safety.ts';
import { createArchiveWorkspace, createTruncatedTgz } from './archive-extraction.fixtures.ts';

test('tar inspection rejects declared bytes before draining an over-budget entry', async () => {
  const workspace = await createArchiveWorkspace();
  try {
    await createTruncatedTgz(workspace.archivePath);
    const budget = new ArchiveBudget({ maxBytes: 1 });
    const error = await extractTarArchive({
      archivePath: workspace.archivePath,
      outputRoot: workspace.outputRoot,
      gzip: true,
      budget,
    }).then(
      () => null,
      (cause: unknown) => cause,
    );

    assert.equal(error instanceof AppError, true);
    assert.equal((error as AppError).details?.reason, 'ARCHIVE_EXPANDED_BYTES_LIMIT');
    assert.equal(budget.bytes, 0);
    assert.equal(budget.entries, 0);
    assert.deepEqual(await fs.readdir(workspace.outputRoot), []);
  } finally {
    await fs.rm(workspace.root, { recursive: true, force: true });
  }
});
