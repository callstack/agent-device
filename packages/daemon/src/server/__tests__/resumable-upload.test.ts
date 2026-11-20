import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import {
  beginResumableUpload,
  finalizeResumableUpload,
  receiveResumableUploadChunk,
} from '../resumable-upload.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { runCmdSync } from '@agent-device/host-kit/command';

function acceptedWrite(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('finalizing an unknown upload reports expiry with a recovery hint', async () => {
  const error = await finalizeResumableUpload('missing-upload-id').then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(error instanceof AppError, true);
  const appError = error as AppError;
  assert.equal(appError.code, 'COMMAND_FAILED');
  assert.equal(appError.message, 'Upload not found or expired: missing-upload-id');
  assert.equal(appError.details?.reason, 'RESOURCE_EXPIRED');
  assert.equal(typeof appError.details?.hint, 'string');
});

test('oversized ranged chunks roll back atomically and can be retried and finalized', async () => {
  const bytes = Buffer.from('ABCDE');
  const uploadId = beginUpload(bytes).uploadId;
  await assert.rejects(
    receiveResumableUploadChunk({
      uploadId,
      req: request(Buffer.from('ABC'), { 'content-range': 'bytes 0-1/5' }),
    }),
    /permitted byte range/i,
  );
  assert.deepEqual(
    await receiveResumableUploadChunk({
      uploadId,
      req: request(Buffer.from('AB'), { 'content-range': 'bytes 0-1/5' }),
    }),
    { complete: false, offset: 2 },
  );
  await receiveResumableUploadChunk({
    uploadId,
    req: request(Buffer.from('CDE'), { 'content-range': 'bytes 2-4/5' }),
  });
  const finalized = await finalizeResumableUpload(uploadId);
  try {
    assert.equal(fs.readFileSync(finalized.artifactPath, 'utf8'), 'ABCDE');
  } finally {
    fs.rmSync(finalized.tempDir, { recursive: true, force: true });
  }
});

test('finalize extracts a gzip-compressed app bundle upload', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-resumable-gzip-');
  const appDir = path.join(tempRoot, 'Sample.app');
  const archivePath = path.join(tempRoot, 'Sample.tar.gz');
  try {
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'payload.txt'), 'payload');
    runCmdSync('tar', ['czf', archivePath, '-C', tempRoot, 'Sample.app'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const archive = fs.readFileSync(archivePath);
    const uploadId = beginResumableUpload({
      ...uploadOptions(archive),
      fileName: 'Sample.app',
      artifactType: 'app-bundle',
      platform: 'ios',
      contentType: 'application/gzip',
    }).uploadId;
    await receiveResumableUploadChunk({ uploadId, req: request(archive) });

    const finalized = await finalizeResumableUpload(uploadId);
    try {
      assert.equal(
        fs.readFileSync(path.join(finalized.artifactPath, 'payload.txt'), 'utf8'),
        'payload',
      );
    } finally {
      fs.rmSync(finalized.tempDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('an early finalize keeps the upload resumable', async () => {
  const bytes = Buffer.from('resume');
  const uploadId = beginUpload(bytes).uploadId;
  await assert.rejects(finalizeResumableUpload(uploadId), /incomplete/i);
  await receiveResumableUploadChunk({ uploadId, req: request(bytes) });
  const finalized = await finalizeResumableUpload(uploadId);
  fs.rmSync(finalized.tempDir, { recursive: true, force: true });
});

test('per-ticket operations serialize while an earlier chunk is paused', async () => {
  const bytes = Buffer.from('ABCD');
  const uploadId = beginUpload(bytes).uploadId;
  const first = requestStream({ 'content-range': 'bytes 0-1/4' });
  const second = requestStream({ 'content-range': 'bytes 2-3/4' });
  const firstResult = receiveResumableUploadChunk({ uploadId, req: first });
  const secondResult = receiveResumableUploadChunk({ uploadId, req: second });
  second.end('CD');
  let secondSettled = false;
  void secondResult.finally(() => {
    secondSettled = true;
  });
  await Promise.resolve();
  assert.equal(secondSettled, false);
  first.end('AB');
  assert.deepEqual(await firstResult, { complete: false, offset: 2 });
  assert.deepEqual(await secondResult, { complete: true, offset: 4 });
  const finalized = await finalizeResumableUpload(uploadId);
  fs.rmSync(finalized.tempDir, { recursive: true, force: true });
});

test('expiry aborts an active receive and invalidates the ticket after rollback', async () => {
  vi.useFakeTimers();
  try {
    const bytes = Buffer.from('AB');
    const uploadId = beginUpload(bytes).uploadId;
    const body = requestStream();
    const receiving = receiveResumableUploadChunk({ uploadId, req: body });
    body.write('A');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await assert.rejects(receiving, /expired/i);
    await assert.rejects(finalizeResumableUpload(uploadId), /not found or expired/i);
  } finally {
    vi.useRealTimers();
  }
});

test('an ignored out-of-order chunk does not extend upload expiry', async () => {
  vi.useFakeTimers();
  try {
    const bytes = Buffer.from('AB');
    const uploadId = beginUpload(bytes).uploadId;
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);

    assert.deepEqual(
      await receiveResumableUploadChunk({
        uploadId,
        req: request(Buffer.from('B'), { 'content-range': 'bytes 1-1/2' }),
      }),
      { complete: false, offset: 0 },
    );

    await vi.advanceTimersByTimeAsync(60 * 1000);
    await assert.rejects(finalizeResumableUpload(uploadId), /not found or expired/i);
  } finally {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    vi.useRealTimers();
  }
});

test('an ignored un-ranged retry does not extend upload expiry', async () => {
  vi.useFakeTimers();
  try {
    const bytes = Buffer.from('ABC');
    const uploadId = beginUpload(bytes).uploadId;
    await receiveResumableUploadChunk({
      uploadId,
      req: request(Buffer.from('A'), { 'content-range': 'bytes 0-0/3' }),
    });
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);

    assert.deepEqual(
      await receiveResumableUploadChunk({ uploadId, req: request(Buffer.from('A')) }),
      { complete: false, offset: 1 },
    );

    await vi.advanceTimersByTimeAsync(60 * 1000);
    await assert.rejects(finalizeResumableUpload(uploadId), /not found or expired/i);
  } finally {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    vi.useRealTimers();
  }
});

test('accepted body progress renews the ticket idle lifetime mid-chunk', async () => {
  // Fake only the ticket clock; real stream I/O keeps running (repo fake-timer pattern).
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const body = requestStream();
  try {
    const bytes = Buffer.from('ABC');
    const options = uploadOptions(bytes);
    const uploadId = beginResumableUpload(options).uploadId;
    let accepted = acceptedWrite();
    const receiving = receiveResumableUploadChunk({
      uploadId,
      req: body,
      onAcceptedBytes: () => accepted.resolve(),
    });
    try {
      body.write('A');
      await Promise.race([accepted.promise, receiving]);
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      accepted = acceptedWrite();
      body.write('B');
      await Promise.race([accepted.promise, receiving]);
      // 8 minutes since the ticket was created, but only 4 since accepted bytes:
      // the idempotent preflight still resolves to the same live ticket.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      assert.equal(beginResumableUpload(options).uploadId, uploadId);
      body.end('C');
      assert.deepEqual(await receiving, { complete: true, offset: 3 });
    } finally {
      body.destroy();
      await receiving.catch(() => {});
    }
    // Idle after the last accepted byte: the ticket expires on schedule.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    await assert.rejects(finalizeResumableUpload(uploadId), /not found or expired/i);
  } finally {
    vi.useRealTimers();
  }
});

test('finalize is not expired by the idle timer during its post-write checks', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    const bytes = Buffer.from('AB');
    const options = uploadOptions(bytes);
    const uploadId = beginResumableUpload(options).uploadId;
    await receiveResumableUploadChunk({ uploadId, req: request(bytes) });
    const finalizing = finalizeResumableUpload(uploadId);
    // The idle timer armed at the last accepted chunk must not fire mid-finalize:
    // past the deadline the ticket still resolves to the finalizing entry.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    assert.equal(beginResumableUpload(options).uploadId, uploadId);
    const finalized = await finalizing;
    try {
      assert.equal(fs.readFileSync(finalized.artifactPath, 'utf8'), 'AB');
    } finally {
      fs.rmSync(finalized.tempDir, { recursive: true, force: true });
    }
    await assert.rejects(finalizeResumableUpload(uploadId), /not found or expired/i);
  } finally {
    vi.useRealTimers();
  }
});

test('an incomplete finalize leaves the original idle lifetime intact', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    const bytes = Buffer.from('AB');
    const uploadId = beginUpload(bytes).uploadId;
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    // The incomplete finalize is not terminal and must not disarm the idle timer:
    // the ticket still expires at the original deadline, 5 minutes after creation.
    await assert.rejects(finalizeResumableUpload(uploadId), /incomplete/i);
    await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
    await assert.rejects(finalizeResumableUpload(uploadId), /not found or expired/i);
  } finally {
    vi.useRealTimers();
  }
});

test('an aborted ingress signal maps to its owned typed reason and rolls back the chunk', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const flushIO = async () => {
    for (let i = 0; i < 100; i += 1) await new Promise((r) => setImmediate(r));
  };
  try {
    const bytes = Buffer.from('ABCD');
    const uploadId = beginUpload(bytes).uploadId;
    const controller = new AbortController();
    const body = requestStream({ 'content-range': 'bytes 0-3/4' });
    const receiving = receiveResumableUploadChunk({
      uploadId,
      req: body,
      signal: controller.signal,
    });
    body.write('AB');
    await flushIO();
    controller.abort(
      new AppError('COMMAND_FAILED', 'Upload transfer deadline exceeded', {
        reason: 'transfer_ingress_deadline_exceeded',
        transferPhase: 'request-body',
        timeoutMs: 600_000,
      }),
    );
    const error = (await receiving.then(
      () => null,
      (error: unknown) => error,
    )) as AppError | null;
    assert.equal(error instanceof AppError, true);
    assert.equal(error?.details?.reason, 'transfer_ingress_deadline_exceeded');
    assert.equal(error?.details?.timeoutMs, 600_000);
    // The chunk rolled back to the pre-chunk offset and the ticket stays resumable:
    // a full retry completes the upload.
    assert.deepEqual(
      await receiveResumableUploadChunk({
        uploadId,
        req: request(bytes, { 'content-range': 'bytes 0-3/4' }),
      }),
      { complete: true, offset: 4 },
    );
    const finalized = await finalizeResumableUpload(uploadId);
    try {
      assert.equal(fs.readFileSync(finalized.artifactPath, 'utf8'), 'ABCD');
    } finally {
      fs.rmSync(finalized.tempDir, { recursive: true, force: true });
    }
  } finally {
    vi.useRealTimers();
  }
});

test('an earlier classified pipeline failure survives a later abort of the same signal', async () => {
  const bytes = Buffer.from('AB');
  const uploadId = beginUpload(bytes).uploadId;
  const controller = new AbortController();
  const body = requestStream({ 'content-range': 'bytes 0-0/2' });
  const accepted = acceptedWrite();
  const receiving = receiveResumableUploadChunk({
    uploadId,
    req: body,
    signal: controller.signal,
    onAcceptedBytes: () => accepted.resolve(),
  });
  const outcome = receiving.then(
    () => null,
    (error: unknown) => error,
  );
  body.write('A');
  await Promise.race([accepted.promise, receiving]);
  const closed = new Promise<void>((resolve) => body.once('close', resolve));
  body.destroy(
    new AppError('COMMAND_FAILED', 'Upload expired while receiving data', {
      reason: 'RESOURCE_EXPIRED',
    }),
  );
  await closed;
  controller.abort(
    new AppError('COMMAND_FAILED', 'Upload transfer deadline exceeded', {
      reason: 'transfer_ingress_deadline_exceeded',
    }),
  );
  const error = (await outcome) as AppError | null;
  assert.equal(error instanceof AppError, true);
  assert.equal(error?.details?.reason, 'RESOURCE_EXPIRED');
});

test('an ingress owner aborted while finalize waits in the admission queue owns the rejection and the ticket recovers', async () => {
  const flushIO = async () => {
    for (let i = 0; i < 100; i += 1) await new Promise((r) => setImmediate(r));
  };
  const bytes = Buffer.from('AB');
  const uploadId = beginUpload(bytes).uploadId;
  // Occupy the serialized admission queue with a receive that stays open.
  const blocker = requestStream({ 'content-range': 'bytes 0-1/2' });
  const receiving = receiveResumableUploadChunk({ uploadId, req: blocker });
  blocker.write('A');
  await flushIO();
  const controller = new AbortController();
  const finalizing = finalizeResumableUpload(uploadId, undefined, {
    signal: controller.signal,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  await flushIO();
  // The synthetic owner fires while the finalize is still pending admission.
  controller.abort(
    new AppError('COMMAND_FAILED', 'Upload transfer deadline exceeded', {
      reason: 'transfer_ingress_deadline_exceeded',
      transferPhase: 'request-body',
      timeoutMs: 600_000,
    }),
  );
  blocker.end('B');
  assert.deepEqual(await receiving, { complete: true, offset: 2 });
  const error = (await finalizing) as AppError | null;
  assert.equal(error instanceof AppError, true);
  assert.equal(error?.details?.reason, 'transfer_ingress_deadline_exceeded');
  // Ownership is preserved: the aborted admission did not close the ticket, so a
  // fresh finalize without the owner still succeeds (recovery).
  const finalized = await finalizeResumableUpload(uploadId);
  try {
    assert.equal(fs.readFileSync(finalized.artifactPath, 'utf8'), 'AB');
  } finally {
    fs.rmSync(finalized.tempDir, { recursive: true, force: true });
  }
});

test('an aborted queued PUT releases at once while later work still waits for the active owner', async () => {
  const flushIO = async () => {
    for (let i = 0; i < 100; i += 1) await new Promise((r) => setImmediate(r));
  };
  const bytes = Buffer.from('AB');
  const uploadId = beginUpload(bytes).uploadId;
  const blocker = requestStream({ 'content-range': 'bytes 0-1/2' });
  const receiving = receiveResumableUploadChunk({ uploadId, req: blocker });
  blocker.write('A');
  await flushIO();
  const controller = new AbortController();
  const queued = receiveResumableUploadChunk({
    uploadId,
    req: requestStream({ 'content-range': 'bytes 0-1/2' }),
    signal: controller.signal,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  const finalizing = finalizeResumableUpload(uploadId);
  let finalizeSettled = false;
  void finalizing.then(
    () => {
      finalizeSettled = true;
    },
    () => {
      finalizeSettled = true;
    },
  );
  await flushIO();
  let queuedOutcome: unknown = 'pending';
  void queued.then((outcome) => {
    queuedOutcome = outcome;
  });
  controller.abort(createRequestCanceledError());
  await flushIO();
  // The disconnected waiter is released without waiting for the receive it does not own.
  assert.equal(queuedOutcome instanceof AppError, true, 'the aborted waiter settles at once');
  assert.equal((queuedOutcome as AppError).details?.reason, 'request_canceled');
  // Serialization holds: the finalize queued behind the released waiter still waits.
  assert.equal(finalizeSettled, false);
  blocker.end('B');
  assert.deepEqual(await receiving, { complete: true, offset: 2 });
  const finalized = await finalizing;
  try {
    assert.equal(fs.readFileSync(finalized.artifactPath, 'utf8'), 'AB');
  } finally {
    fs.rmSync(finalized.tempDir, { recursive: true, force: true });
  }
});

test('a chunk cancelled during its final offset check rolls back and never advances the offset', async () => {
  const bytes = Buffer.from('ABCD');
  const uploadId = beginUpload(bytes).uploadId;
  const controller = new AbortController();
  const stat = fs.promises.stat.bind(fs.promises);
  let payloadStats = 0;
  const held = vi.spyOn(fs.promises, 'stat').mockImplementation((async (
    target: fs.PathLike,
    options?: fs.StatOptions,
  ) => {
    const result = await stat(target, options);
    if (path.basename(String(target)) === 'payload' && (payloadStats += 1) === 2) {
      // The body is fully appended; the owner fires before the offset is committed.
      controller.abort(
        new AppError('COMMAND_FAILED', 'Upload transfer deadline exceeded', {
          reason: 'transfer_ingress_deadline_exceeded',
        }),
      );
    }
    return result;
  }) as typeof fs.promises.stat);
  try {
    const error = (await receiveResumableUploadChunk({
      uploadId,
      req: request(bytes, { 'content-range': 'bytes 0-3/4' }),
      signal: controller.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    )) as AppError | null;
    assert.equal(payloadStats, 2);
    assert.equal(error instanceof AppError, true);
    assert.equal(error?.details?.reason, 'transfer_ingress_deadline_exceeded');
  } finally {
    held.mockRestore();
  }
  // The cancelled chunk rolled back: a full retry from offset zero completes.
  assert.deepEqual(
    await receiveResumableUploadChunk({
      uploadId,
      req: request(bytes, { 'content-range': 'bytes 0-3/4' }),
    }),
    { complete: true, offset: 4 },
  );
  const finalized = await finalizeResumableUpload(uploadId);
  fs.rmSync(finalized.tempDir, { recursive: true, force: true });
});

test('an ingress owner aborted mid-hash cancels the finalize with its typed reason and cleans up', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-finalize-abort-');
  const previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = tempRoot;
  try {
    // 64 MiB stays under the 2 GiB cap but hashes across real I/O time, so the
    // synthetic owner can fire mid-hash.
    const bytes = Buffer.alloc(64 * 1024 * 1024, 0x61);
    const uploadId = beginUpload(bytes).uploadId;
    await receiveResumableUploadChunk({ uploadId, req: request(bytes) });
    const controller = new AbortController();
    const finalizing = finalizeResumableUpload(uploadId, undefined, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(
      new AppError('COMMAND_FAILED', 'Upload transfer deadline exceeded', {
        reason: 'transfer_ingress_deadline_exceeded',
        transferPhase: 'request-body',
        timeoutMs: 600_000,
      }),
    );
    const error = (await finalizing.then(
      () => null,
      (error: unknown) => error,
    )) as AppError | null;
    assert.equal(error instanceof AppError, true);
    assert.equal(error?.details?.reason, 'transfer_ingress_deadline_exceeded');
    // Semantic cleanup: the terminal failure closed the ticket and removed its temp
    // dir, so a retry reports expiry and the temp root is empty.
    await assert.rejects(finalizeResumableUpload(uploadId), /not found or expired/i);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('finalize with a live ingress signal succeeds through the owned post-body phases', async () => {
  const bytes = Buffer.from('OWNED');
  const uploadId = beginUpload(bytes).uploadId;
  await receiveResumableUploadChunk({ uploadId, req: request(bytes) });
  const controller = new AbortController();
  const finalized = await finalizeResumableUpload(uploadId, undefined, {
    signal: controller.signal,
  });
  try {
    assert.equal(controller.signal.aborted, false);
    assert.equal(fs.readFileSync(finalized.artifactPath, 'utf8'), 'OWNED');
  } finally {
    fs.rmSync(finalized.tempDir, { recursive: true, force: true });
  }
});

test('idempotent preflight does not extend upload expiry', async () => {
  vi.useFakeTimers();
  try {
    const bytes = Buffer.from('AB');
    const options = uploadOptions(bytes);
    const uploadId = beginResumableUpload(options).uploadId;
    await receiveResumableUploadChunk({
      uploadId,
      req: request(Buffer.from('A'), { 'content-range': 'bytes 0-0/2' }),
    });
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);

    assert.equal(beginResumableUpload(options).uploadId, uploadId);

    await vi.advanceTimersByTimeAsync(60 * 1000);
    await assert.rejects(finalizeResumableUpload(uploadId), /not found or expired/i);
  } finally {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    vi.useRealTimers();
  }
});

function beginUpload(bytes: Buffer): ReturnType<typeof beginResumableUpload> {
  return beginResumableUpload(uploadOptions(bytes));
}

function uploadOptions(bytes: Buffer): Parameters<typeof beginResumableUpload>[0] {
  return {
    baseUrl: 'http://127.0.0.1:1234',
    tokenHeaders: {},
    uploadAttemptId: crypto.randomUUID(),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    fileName: 'artifact.bin',
    sizeBytes: bytes.length,
    artifactType: 'file',
  };
}

function request(body: Buffer, headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from(body), { headers }) as IncomingMessage;
}

function requestStream(headers: Record<string, string> = {}): PassThrough & IncomingMessage {
  return Object.assign(new PassThrough(), { headers }) as PassThrough & IncomingMessage;
}
