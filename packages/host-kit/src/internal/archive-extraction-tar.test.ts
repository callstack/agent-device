import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test, vi } from 'vitest';
import * as tar from 'tar-stream';
import { AppError } from '@agent-device/kernel/errors';
import { extractTarArchive } from './archive-extraction-tar.ts';
import { ArchiveBudget } from './archive-safety.ts';
import { createArchiveWorkspace, createTruncatedTgz } from '../archive.fixtures.ts';

/** While set, entry writers hold each file write until the release resolves. */
const writeHold = vi.hoisted(() => ({
  current: undefined as undefined | { started: () => void; release: Promise<void> },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const createWriteStream: typeof actual.createWriteStream = (path, options) => {
    const hold = writeHold.current;
    if (!hold || typeof options !== 'object') return actual.createWriteStream(path, options);
    return actual.createWriteStream(path, {
      ...options,
      fs: {
        open: actual.open,
        close: actual.close,
        write(...args: unknown[]) {
          hold.started();
          void hold.release.then(() => Reflect.apply(actual.write, actual, args));
        },
      },
    });
  };
  return { ...actual, createWriteStream };
});

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
    // No entry writer opened after the cancellation, so nothing outlives the cleanup.
    assert.deepEqual(await fs.readdir(workspace.outputRoot), []);
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

test('a tar extraction cancelled with an entry write in flight joins the write before it settles', async () => {
  const workspace = await createArchiveWorkspace();
  const rejections: unknown[] = [];
  const observeRejection = (reason: unknown) => rejections.push(reason);
  const writeStarted = barrier();
  const releaseWrite = barrier();
  process.on('unhandledRejection', observeRejection);
  try {
    const pack = tar.pack();
    pack.entry({ name: 'payload.bin' }, Buffer.alloc(64 * 1024, 0x61));
    pack.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of pack) chunks.push(Buffer.from(chunk));
    await fs.writeFile(workspace.archivePath, Buffer.concat(chunks));
    writeHold.current = { started: writeStarted.resolve, release: releaseWrite.promise };
    const controller = new AbortController();
    let settled = false;
    const outcome = extractTarArchive({
      archivePath: workspace.archivePath,
      outputRoot: workspace.outputRoot,
      gzip: false,
      signal: controller.signal,
    })
      .then(
        () => null,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    await writeStarted.promise;
    controller.abort(
      new AppError('COMMAND_FAILED', 'Upload transfer deadline exceeded', {
        reason: 'transfer_ingress_deadline_exceeded',
      }),
    );
    await flushIO();
    assert.equal(settled, false, 'the extraction waits for its in-flight write');
    releaseWrite.resolve();
    const error = await outcome;
    assert.equal((error as AppError).details?.reason, 'transfer_ingress_deadline_exceeded');
    // Cleanup after the outcome is final: no write lands after the output is removed.
    await fs.rm(workspace.outputRoot, { recursive: true, force: true });
    await fs.mkdir(workspace.outputRoot);
    await flushIO();
    assert.deepEqual(await fs.readdir(workspace.outputRoot), []);
    assert.deepEqual(rejections, []);
  } finally {
    writeHold.current = undefined;
    releaseWrite.resolve();
    process.off('unhandledRejection', observeRejection);
    await fs.rm(workspace.root, { recursive: true, force: true });
  }
});
