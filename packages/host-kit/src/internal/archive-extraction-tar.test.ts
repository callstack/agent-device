import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test, vi } from 'vitest';
import * as tar from 'tar-stream';
import { AppError } from '@agent-device/kernel/errors';
import { extractTarArchive } from './archive-extraction-tar.ts';
import { ArchiveBudget } from './archive-safety.ts';
import { createArchiveWorkspace, createTruncatedTgz } from '../archive.fixtures.ts';

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
      (error: unknown) => error,
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

test('a tar extraction cancelled during an entry filesystem operation keeps its typed reason without an unhandled rejection', async () => {
  const workspace = await createArchiveWorkspace();
  const rejections: unknown[] = [];
  const observeRejection = (reason: unknown) => rejections.push(reason);
  const entryStarted = barrier();
  const releaseEntry = barrier();
  const mkdir = fs.mkdir.bind(fs);
  const held = vi.spyOn(fs, 'mkdir').mockImplementation(async (target, options) => {
    if (target === workspace.outputRoot) {
      entryStarted.resolve();
      await releaseEntry.promise;
    }
    return await mkdir(target, options);
  });
  process.on('unhandledRejection', observeRejection);
  try {
    await createSingleFileTar(workspace.archivePath);
    const controller = new AbortController();
    const outcome = extractTarArchive({
      archivePath: workspace.archivePath,
      outputRoot: workspace.outputRoot,
      gzip: false,
      signal: controller.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    // The entry loop awaits the held filesystem operation while the signal fires.
    await entryStarted.promise;
    controller.abort(
      new AppError('COMMAND_FAILED', 'Upload transfer deadline exceeded', {
        reason: 'transfer_ingress_deadline_exceeded',
      }),
    );
    await flushIO();
    assert.deepEqual(rejections, [], 'the cancelled pipeline never reaches the process');
    releaseEntry.resolve();
    const error = await outcome;
    assert.equal(error instanceof AppError, true);
    assert.equal((error as AppError).details?.reason, 'transfer_ingress_deadline_exceeded');
    await flushIO();
    assert.deepEqual(rejections, []);
  } finally {
    releaseEntry.resolve();
    process.off('unhandledRejection', observeRejection);
    held.mockRestore();
    await fs.rm(workspace.root, { recursive: true, force: true });
  }
});

async function createSingleFileTar(archivePath: string): Promise<void> {
  const pack = tar.pack();
  pack.entry({ name: 'payload.bin' }, Buffer.from('AB'));
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  await fs.writeFile(archivePath, Buffer.concat(chunks));
}

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushIO(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}
