import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { extractZipArchive } from '../archive-extraction-zip.ts';
import { ArchiveBudget } from '../archive-safety.ts';
import {
  createArchiveWorkspace,
  createZipWithEncryptedSecondEntry,
} from './archive-extraction.fixtures.ts';

test('zip inspection stops at the entry budget before inspecting later entries', async () => {
  const workspace = await createArchiveWorkspace();
  try {
    await createZipWithEncryptedSecondEntry(workspace.archivePath);
    const budget = new ArchiveBudget({ maxEntries: 1 });
    const error = await extractZipArchive({
      archivePath: workspace.archivePath,
      outputRoot: workspace.outputRoot,
      budget,
    }).then(
      () => null,
      (cause: unknown) => cause,
    );

    assert.equal(error instanceof AppError, true);
    assert.equal((error as AppError).details?.reason, 'ARCHIVE_ENTRY_LIMIT');
    assert.equal(budget.bytes, 0);
    assert.equal(budget.entries, 0);
    assert.deepEqual(await fs.readdir(workspace.outputRoot), []);
  } finally {
    await fs.rm(workspace.root, { recursive: true, force: true });
  }
});
