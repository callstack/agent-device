import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { AppError } from '@agent-device/kernel/errors';
import {
  beginResumableUpload,
  finalizeResumableUpload,
  receiveResumableUploadChunk,
} from '../resumable-upload.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { runCmdSync } from '@agent-device/host-kit/command';

test('finalizing an unknown upload reports expiry with a recovery hint', async () => {
  const error = await finalizeResumableUpload('missing-upload-id').then(
    () => null,
    (err: unknown) => err,
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
