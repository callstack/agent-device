import fs from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { gunzipSync } from 'node:zlib';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { AppError, isRequestCanceledError, normalizeError } from '@agent-device/kernel/errors';
import { createRuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';
import * as command from '@agent-device/host-kit/command';
import {
  cleanupDownloadableArtifact,
  listDownloadableArtifacts,
  openDownloadableArtifact,
  trackDownloadableArtifact,
  trackUploadedArtifact,
  type OpenedDownloadableArtifact,
} from './artifact-tracking.ts';

test('listing a directory artifact builds no archive until its first download', async () => {
  const root = mkdtempForTestSync('fu-art-inventory-lazy-');
  const artifactPath = path.join(root, 'capture.trace');
  fs.mkdirSync(artifactPath);
  fs.writeFileSync(path.join(artifactPath, 'payload'), 'directory artifact');
  const runtime = createRuntimeStateHandle();
  const archive = vi.spyOn(command, 'runCmd');
  const downloads: OpenedDownloadableArtifact[] = [];
  try {
    const id = runtime.run(() =>
      trackDownloadableArtifact({ artifactPath, artifactType: 'trace-log' }),
    );
    const listed = await runtime.run(() => listDownloadableArtifacts(undefined));
    expect(listed).toEqual([
      expect.objectContaining({
        id,
        filename: 'capture.trace.tar.gz',
        mimeType: 'application/gzip',
      }),
    ]);
    expect(listed[0]).not.toHaveProperty('sizeBytes');
    expect(archive).not.toHaveBeenCalled();

    const download = await runtime.run(() => openDownloadableArtifact(id, undefined, process.env));
    downloads.push(download);
    expect(archive).toHaveBeenCalledTimes(1);
    const relisted = await runtime.run(() => listDownloadableArtifacts(undefined));
    expect(relisted[0]?.sizeBytes).toBe(download.sizeBytes);
  } finally {
    for (const download of downloads) {
      download.stream.destroy();
      await vi.waitFor(() => expect(download.stream.closed).toBe(true));
      download.release();
    }
    runtime.dispose();
    archive.mockRestore();
  }
});

test('a missing cached directory archive is rebuilt from the live source', async () => {
  const root = mkdtempForTestSync('fu-art-cache-rebuild-');
  const artifactPath = path.join(root, 'capture.trace');
  const expected = Buffer.from('live source after cached archive disappears');
  fs.mkdirSync(artifactPath);
  fs.writeFileSync(path.join(artifactPath, 'payload'), expected);
  const runtime = createRuntimeStateHandle();
  const downloads: OpenedDownloadableArtifact[] = [];
  try {
    const id = runtime.run(() =>
      trackDownloadableArtifact({ artifactPath, artifactType: 'trace-log' }),
    );
    const first = await runtime.run(() => openDownloadableArtifact(id, undefined, process.env));
    downloads.push(first);
    expect(gunzipSync(await buffer(first.stream)).includes(expected)).toBe(true);
    await vi.waitFor(() => expect(first.stream.closed).toBe(true));
    first.release();
    const oldArchive = String(first.stream.path);
    fs.unlinkSync(oldArchive);
    expect(fs.existsSync(artifactPath)).toBe(true);
    const second = await runtime.run(() => openDownloadableArtifact(id, undefined, process.env));
    downloads.push(second);
    expect(gunzipSync(await buffer(second.stream)).includes(expected)).toBe(true);
    await vi.waitFor(() => expect(second.stream.closed).toBe(true));
    second.release();
    expect(String(second.stream.path)).not.toBe(oldArchive);
    expect(fs.existsSync(path.dirname(oldArchive))).toBe(false);
    runtime.run(() => cleanupDownloadableArtifact(id));
    expect(fs.existsSync(artifactPath)).toBe(false);
    expect(fs.existsSync(path.dirname(String(second.stream.path)))).toBe(false);
  } finally {
    for (const download of downloads) {
      download.stream.destroy();
      await vi.waitFor(() => expect(download.stream.closed).toBe(true));
      download.release();
    }
    runtime.dispose();
  }
});

test('cancelling the archive builder preserves a second download waiting for its full archive', async () => {
  const root = mkdtempForTestSync('fu-art-shared-build-');
  const artifactPath = path.join(root, 'capture.trace');
  fs.mkdirSync(artifactPath);
  const expected = 'complete shared capture payload\n'.repeat(4096);
  fs.writeFileSync(path.join(artifactPath, 'payload'), expected);
  const runtime = createRuntimeStateHandle();
  let continueArchive!: () => void;
  const blocked = new Promise<void>((resolve) => {
    continueArchive = resolve;
  });
  let archiveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    archiveStarted = resolve;
  });
  const runCmd = command.runCmd;
  const archive = vi.spyOn(command, 'runCmd').mockImplementationOnce(async (...args) => {
    archiveStarted();
    await blocked;
    return await runCmd(...args);
  });
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const openings: Array<Promise<OpenedDownloadableArtifact>> = [];
  try {
    const id = runtime.run(() =>
      trackDownloadableArtifact({ artifactPath, artifactType: 'trace-log' }),
    );
    const timerIndex = timers.mock.calls.length;
    const first = runtime.run(() => openDownloadableArtifact(id, undefined, process.env));
    openings.push(first);
    void first.catch(() => {});
    const cancelFirst = timers.mock.calls[timerIndex]![0];
    await started;
    const second = runtime.run(() => openDownloadableArtifact(id, undefined, process.env));
    openings.push(second);
    void second.catch(() => {});
    runtime.run(cancelFirst);
    continueArchive();
    const download = await second;
    const closed = once(download.stream, 'close');
    const bytes = await buffer(download.stream);
    await closed;
    download.release();
    expect(bytes).toHaveLength(download.sizeBytes);
    expect(gunzipSync(bytes).includes(Buffer.from(expected))).toBe(true);
    await expect(first).rejects.toMatchObject({ details: { reason: 'RESOURCE_EXPIRED' } });
    expect(archive).toHaveBeenCalledTimes(1);
    runtime.run(() => cleanupDownloadableArtifact(id));
    expect(fs.existsSync(artifactPath)).toBe(false);
    expect(fs.existsSync(path.dirname(String(download.stream.path)))).toBe(false);
  } finally {
    continueArchive();
    const results = await Promise.allSettled(openings);
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const download = result.value;
      if (!download.stream.closed) {
        const closed = once(download.stream, 'close');
        download.stream.destroy();
        await closed;
      }
      download.release();
    }
    runtime.dispose();
    timers.mockRestore();
    archive.mockRestore();
  }
});

test.each(['deadline-aborted', 'late-aborted'] as const)(
  'a live artifact starts a fresh archive while a %s build is settling',
  async (failure) => {
    const root = mkdtempForTestSync('fu-art-retry-build-');
    const artifactPath = path.join(root, 'capture.trace');
    fs.mkdirSync(artifactPath);
    const expected = Buffer.from('fresh archive payload');
    fs.writeFileSync(path.join(artifactPath, 'payload'), expected);
    const runtime = createRuntimeStateHandle();
    let finishAborted!: () => void;
    const settling = new Promise<void>((resolve) => {
      finishAborted = resolve;
    });
    let aborted!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let tarSucceeded!: () => void;
    const succeeded = new Promise<void>((resolve) => {
      tarSucceeded = resolve;
    });
    let firstArchiveDir = '';
    const runCmd = command.runCmd;
    const archive = vi.spyOn(command, 'runCmd').mockImplementationOnce(async (...args) => {
      firstArchiveDir = path.dirname(String(args[1]?.[1]));
      args[2]?.signal?.addEventListener('abort', aborted, { once: true });
      if (failure === 'late-aborted') {
        const result = await runCmd(...args);
        tarSucceeded();
        await settling;
        return result;
      }
      await settling;
      return await runCmd(...args);
    });
    const openings: Array<Promise<OpenedDownloadableArtifact>> = [];
    try {
      const id = runtime.run(() =>
        trackDownloadableArtifact({ artifactPath, artifactType: 'trace-log' }),
      );
      const timers = vi.spyOn(globalThis, 'setTimeout');
      const first = runtime.run(() => openDownloadableArtifact(id, undefined, process.env));
      openings.push(first);
      void first.catch(() => {});
      const deadline = timers.mock.calls.find(([, delay]) => delay === 15 * 60 * 1000)?.[0];
      timers.mockRestore();
      if (failure === 'late-aborted') await succeeded;
      expect(deadline).toBeTypeOf('function');
      runtime.run(() => deadline!());
      await cancelled;
      const second = runtime.run(() => openDownloadableArtifact(id, undefined, process.env));
      openings.push(second);
      void second.catch(() => {});
      finishAborted();
      await expect(first).rejects.toMatchObject({ details: { reason: 'RESOURCE_EXPIRED' } });
      expect(fs.existsSync(firstArchiveDir)).toBe(false);
      const download = await second;
      const closed = once(download.stream, 'close');
      const bytes = await buffer(download.stream);
      await closed;
      download.release();
      expect(gunzipSync(bytes).includes(expected)).toBe(true);
      expect(archive).toHaveBeenCalledTimes(2);
      if (failure === 'late-aborted') runtime.dispose();
      else runtime.run(() => cleanupDownloadableArtifact(id));
      expect(fs.existsSync(artifactPath)).toBe(false);
      expect(fs.existsSync(path.dirname(String(download.stream.path)))).toBe(false);
    } finally {
      finishAborted();
      for (const result of await Promise.allSettled(openings)) {
        if (result.status !== 'fulfilled') continue;
        const download = result.value;
        if (!download.stream.closed) {
          const closed = once(download.stream, 'close');
          download.stream.destroy();
          await closed;
        }
        download.release();
      }
      runtime.dispose();
      archive.mockRestore();
    }
  },
);

test.each(['before opening', 'while archiving'] as const)(
  'caller cancellation %s has a typed reason without forwarding caller data',
  async (phase) => {
    const root = mkdtempForTestSync('fu-art-client-cancel-');
    const artifactPath = path.join(root, 'capture.trace');
    fs.mkdirSync(artifactPath);
    fs.writeFileSync(path.join(artifactPath, 'payload'), 'cancelled payload');
    const runtime = createRuntimeStateHandle();
    const archive = vi.spyOn(command, 'runCmd').mockImplementationOnce(async (...args) => {
      const signal = args[2]!.signal!;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      throw new Error('aborted tar cannot complete');
    });
    const caller = new AbortController();
    const reason = new AppError('COMMAND_FAILED', 'private caller cancellation data', {
      reason: 'RESOURCE_EXPIRED',
    });
    let opening: Promise<OpenedDownloadableArtifact> | undefined;
    try {
      const id = runtime.run(() =>
        trackDownloadableArtifact({ artifactPath, artifactType: 'trace-log' }),
      );
      if (phase === 'before opening') caller.abort(reason);
      opening = runtime.run(() =>
        openDownloadableArtifact(id, undefined, process.env, caller.signal),
      );
      void opening.catch(() => {});
      if (phase === 'while archiving') caller.abort(reason);
      const error = await opening.catch((error: unknown) => error);
      expect(isRequestCanceledError(error)).toBe(true);
      const normalized = normalizeError(error);
      expect(normalized).toMatchObject({
        code: 'COMMAND_FAILED',
        message: 'request canceled',
        details: { reason: 'request_canceled' },
      });
      expect(JSON.stringify(normalized)).not.toContain('private caller cancellation data');
      expect(JSON.stringify(normalized)).not.toContain('RESOURCE_EXPIRED');
      expect(fs.existsSync(artifactPath)).toBe(true);
      runtime.run(() => cleanupDownloadableArtifact(id));
      expect(fs.existsSync(artifactPath)).toBe(false);
    } finally {
      caller.abort();
      if (opening) await Promise.allSettled([opening]);
      runtime.dispose();
      archive.mockRestore();
    }
  },
);

test('disposing every archive waiter aborts the shared build and removes its temporary directory', async () => {
  const root = mkdtempForTestSync('fu-art-cancel-all-');
  const artifactPath = path.join(root, 'capture.trace');
  fs.mkdirSync(artifactPath);
  fs.writeFileSync(path.join(artifactPath, 'payload'), 'cancelled archive payload');
  const runtime = createRuntimeStateHandle();
  let continueArchive!: () => void;
  const blocked = new Promise<void>((resolve) => {
    continueArchive = resolve;
  });
  let archiveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    archiveStarted = resolve;
  });
  let archiveDir = '';
  let archiveSignal: AbortSignal | undefined;
  const runCmd = command.runCmd;
  const archive = vi.spyOn(command, 'runCmd').mockImplementationOnce(async (...args) => {
    archiveDir = path.dirname(String(args[1]?.[1]));
    archiveSignal = args[2]?.signal;
    archiveStarted();
    await blocked;
    return await runCmd(...args);
  });
  const openings: Array<Promise<OpenedDownloadableArtifact>> = [];
  try {
    const id = runtime.run(() =>
      trackDownloadableArtifact({ artifactPath, artifactType: 'trace-log' }),
    );
    openings.push(runtime.run(() => openDownloadableArtifact(id, undefined, process.env)));
    await started;
    openings.push(runtime.run(() => openDownloadableArtifact(id, undefined, process.env)));
    for (const opening of openings) void opening.catch(() => {});
    runtime.dispose();
    await vi.waitFor(() => expect(archiveSignal?.aborted).toBe(true));
    expect(fs.existsSync(artifactPath)).toBe(true);
    expect(fs.existsSync(archiveDir)).toBe(true);
    continueArchive();
    for (const opening of openings) {
      await expect(opening).rejects.toMatchObject({ details: { reason: 'RESOURCE_EXPIRED' } });
    }
    expect(archive).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(artifactPath)).toBe(false);
    expect(fs.existsSync(archiveDir)).toBe(false);
  } finally {
    continueArchive();
    await Promise.allSettled(openings);
    runtime.dispose();
    archive.mockRestore();
  }
});

function holdArtifactReads() {
  const pending: Array<{ file: string; complete: () => void }> = [];
  const createReadStream = fs.createReadStream;
  let held = true;
  const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) =>
    createReadStream(file, {
      ...(typeof options === 'string' ? { encoding: options } : options),
      fs: {
        open: fs.open,
        close: fs.close,
        read(fd, buffer, offset, length, position, callback) {
          fs.read(fd, buffer, offset, length, position, (error, bytesRead, readBuffer) => {
            const complete = () => callback(error, bytesRead, readBuffer);
            if (held) pending.push({ file: String(file), complete });
            else complete();
          });
        },
      },
    }),
  );
  return {
    pending,
    release: () => {
      held = false;
      for (const { complete } of pending.splice(0)) complete();
    },
    restore: () => spy.mockRestore(),
  };
}

test.each(['old-first', 'new-first'] as const)(
  'disposing two deferred registrations cleans their shared source after pending reads close (%s)',
  async (order) => {
    const root = mkdtempForTestSync('fu-art-shared-dispose-');
    const artifactPath = path.join(root, 'capture.trace');
    fs.mkdirSync(artifactPath);
    fs.writeFileSync(path.join(artifactPath, 'payload'), 'shared source marker');
    const runtime = createRuntimeStateHandle();
    const reads = holdArtifactReads();
    const removed = vi.spyOn(fs, 'rmSync');
    const downloads: OpenedDownloadableArtifact[] = [];
    const track = () =>
      runtime.run(() => trackDownloadableArtifact({ artifactPath, artifactType: 'trace-log' }));
    try {
      const firstId = track();
      downloads.push(
        await runtime.run(() => openDownloadableArtifact(firstId, undefined, process.env)),
      );
      runtime.run(() => cleanupDownloadableArtifact(firstId));
      const secondId = track();
      expect(secondId).not.toBe(firstId);
      downloads.push(
        await runtime.run(() => openDownloadableArtifact(secondId, undefined, process.env)),
      );
      runtime.run(() => cleanupDownloadableArtifact(secondId));
      for (const download of downloads) download.stream.resume();
      await vi.waitFor(() => expect(reads.pending).toHaveLength(2));
      runtime.dispose();
      expect(fs.existsSync(artifactPath)).toBe(true);
      for (const download of downloads) expect(download.stream.closed).toBe(false);
      const firstToClose = downloads[order === 'old-first' ? 0 : 1]!;
      const pendingIndex = reads.pending.findIndex(
        ({ file }) => file === String(firstToClose.stream.path),
      );
      expect(pendingIndex).toBeGreaterThanOrEqual(0);
      reads.pending.splice(pendingIndex, 1)[0]!.complete();
      await vi.waitFor(() =>
        expect(downloads.filter(({ stream }) => stream.closed)).toHaveLength(1),
      );
      expect(firstToClose.stream.closed).toBe(true);
      expect(fs.existsSync(artifactPath)).toBe(true);
      reads.release();
      await vi.waitFor(() => expect(fs.existsSync(artifactPath)).toBe(false));
      for (const download of downloads) {
        expect(download.stream.closed).toBe(true);
        const archiveDir = path.dirname(String(download.stream.path));
        expect(fs.existsSync(archiveDir)).toBe(false);
        expect(removed.mock.calls.filter(([target]) => target === archiveDir)).toHaveLength(1);
      }
      expect(removed.mock.calls.filter(([target]) => target === artifactPath)).toHaveLength(1);
    } finally {
      reads.release();
      runtime.dispose();
      for (const { stream } of downloads) {
        if (!stream.closed) await once(stream, 'close');
      }
      reads.restore();
      removed.mockRestore();
    }
  },
);

test.each(['expiry-first', 'deadline-first'] as const)(
  'a stalled directory read cleans up after registration expiry and its own deadline (%s)',
  async (order) => {
    const root = mkdtempForTestSync('fu-art-stalled-expiry-');
    const artifactPath = path.join(root, 'capture.trace');
    fs.mkdirSync(artifactPath);
    fs.writeFileSync(path.join(artifactPath, 'payload'), 'stalled source marker');
    const runtime = createRuntimeStateHandle();
    const reads = holdArtifactReads();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const clearedTimers = vi.spyOn(globalThis, 'clearTimeout');
    const removed = vi.spyOn(fs, 'rmSync');
    let download: OpenedDownloadableArtifact | undefined;
    try {
      const id = runtime.run(() =>
        trackDownloadableArtifact({ artifactPath, artifactType: 'trace-log' }),
      );
      const expire = timers.mock.calls.at(-1)![0];
      const expiryTimer = timers.mock.results.at(-1)!.value;
      const timerIndex = timers.mock.calls.length;
      const opening = runtime.run(() => openDownloadableArtifact(id, undefined, process.env));
      const deadline = timers.mock.calls[timerIndex]![0];
      download = await opening;
      const archiveDir = path.dirname(String(download.stream.path));
      download.stream.resume();
      await vi.waitFor(() => expect(reads.pending).toHaveLength(1));
      if (order === 'expiry-first') runtime.run(expire);
      expect(download.stream.destroyed).toBe(false);
      expect(fs.existsSync(artifactPath)).toBe(true);
      expect(fs.existsSync(archiveDir)).toBe(true);
      runtime.run(deadline);
      expect(download.signal.aborted).toBe(true);
      expect(download.stream.destroyed).toBe(true);
      expect(download.stream.closed).toBe(false);
      expect(fs.existsSync(artifactPath)).toBe(true);
      reads.release();
      await vi.waitFor(() => expect(download!.stream.closed).toBe(true));
      if (order === 'deadline-first') {
        expect(fs.existsSync(artifactPath)).toBe(true);
        expect(fs.existsSync(archiveDir)).toBe(true);
        expect(clearedTimers.mock.calls.some(([timer]) => timer === expiryTimer)).toBe(false);
        runtime.run(expire);
      }
      await vi.waitFor(() => expect(fs.existsSync(artifactPath)).toBe(false));
      expect(download.stream.closed).toBe(true);
      expect(fs.existsSync(archiveDir)).toBe(false);
      for (const target of [artifactPath, archiveDir]) {
        expect(removed.mock.calls.filter(([removedPath]) => removedPath === target)).toHaveLength(
          1,
        );
      }
    } finally {
      reads.release();
      runtime.dispose();
      if (download && !download.stream.closed) await once(download.stream, 'close');
      timers.mockRestore();
      clearedTimers.mockRestore();
      reads.restore();
      removed.mockRestore();
    }
  },
);

test('disposing a runtime removes the temporary files it still tracks', () => {
  const root = mkdtempForTestSync('agent-device-artifact-dispose-');
  const artifactPath = path.join(root, 'artifact.txt');
  const uploadDir = path.join(root, 'upload');
  fs.writeFileSync(artifactPath, 'artifact');
  fs.mkdirSync(uploadDir);
  fs.writeFileSync(path.join(uploadDir, 'payload'), 'payload');
  const runtime = createRuntimeStateHandle();

  runtime.run(() => {
    trackDownloadableArtifact({
      artifactPath,
      artifactType: 'runtime-artifact',
      fileName: 'artifact.txt',
    });
    trackUploadedArtifact({ artifactPath: path.join(uploadDir, 'payload'), tempDir: uploadDir });
  });
  runtime.dispose();

  expect(fs.existsSync(uploadDir)).toBe(false);
  expect(fs.existsSync(artifactPath)).toBe(false);
});

test('a file tracked twice for one tenant keeps one id, and another tenant gets its own', () => {
  const root = mkdtempForTestSync('agent-device-artifact-reuse-');
  const artifactPath = path.join(root, 'recording.mp4');
  fs.writeFileSync(artifactPath, 'video');
  const runtime = createRuntimeStateHandle();

  const [first, again, otherTenant] = runtime.run(() => {
    const track = (tenantId: string) =>
      trackDownloadableArtifact({
        artifactPath,
        tenantId,
        artifactType: 'screen-recording',
        fileName: 'recording.mp4',
      });
    return [track('tenant-a'), track('tenant-a'), track('tenant-b')];
  });
  runtime.dispose();

  expect(again).toBe(first);
  expect(otherTenant).not.toBe(first);
});

test.each(
  (['old-first', 'new-first'] as const).flatMap((order) =>
    [true, false].map((deleteAfterDownload) => ({ order, deleteAfterDownload })),
  ),
)(
  're-registering a directory during deferred cleanup keeps both downloads alive ($order, deleteAfterDownload=$deleteAfterDownload)',
  async ({ order, deleteAfterDownload }) => {
    const root = mkdtempForTestSync('fu-art-register-');
    const artifactPath = path.join(root, 'capture.trace');
    fs.mkdirSync(artifactPath);
    const payloadPath = path.join(artifactPath, 'payload');
    fs.writeFileSync(payloadPath, 'original capture marker');
    const runtime = createRuntimeStateHandle();
    const downloads: OpenedDownloadableArtifact[] = [];
    const track = (deleteAfterDownload = true) =>
      runtime.run(() =>
        trackDownloadableArtifact({
          artifactPath,
          artifactType: 'trace-log',
          tenantId: 'tenant-a',
          deleteAfterDownload,
        }),
      );
    const open = async (id: string) => {
      const artifact: OpenedDownloadableArtifact = await runtime.run(() =>
        openDownloadableArtifact(id, 'tenant-a', process.env),
      );
      downloads.push(artifact);
      return artifact;
    };
    const read = async (download: OpenedDownloadableArtifact, expected: string) => {
      const { stream } = download;
      const closed = once(stream, 'close');
      const bytes = await buffer(stream);
      await closed;
      download.release();
      download.release();
      expect(gunzipSync(bytes).includes(Buffer.from(expected))).toBe(true);
      expect(fs.existsSync(path.dirname(String(stream.path)))).toBe(false);
    };
    try {
      const firstId = track();
      const first = await open(firstId);
      runtime.run(() => cleanupDownloadableArtifact(firstId));
      fs.writeFileSync(payloadPath, 'replacement capture marker');
      const nextId = track(deleteAfterDownload);
      expect(nextId).not.toBe(firstId);
      if (order === 'old-first') {
        await read(first, 'original capture marker');
        expect(fs.existsSync(artifactPath)).toBe(true);
      }
      const next = await open(nextId);
      runtime.run(() => cleanupDownloadableArtifact(nextId));
      await read(next, 'replacement capture marker');
      if (order === 'new-first') {
        expect(fs.existsSync(artifactPath)).toBe(true);
        await read(first, 'original capture marker');
      }
      expect(fs.existsSync(artifactPath)).toBe(!deleteAfterDownload);
    } finally {
      for (const download of downloads) {
        if (!download.stream.closed) {
          const closed = once(download.stream, 'close');
          download.stream.destroy();
          await closed;
        }
        download.release();
      }
      runtime.dispose();
    }
  },
);
