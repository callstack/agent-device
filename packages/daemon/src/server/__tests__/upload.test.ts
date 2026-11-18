import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { receiveUpload } from '../upload.ts';
import { streamReadableToFile, validateArtifactContentLength } from '../artifact-download.ts';
import { AppError } from '@agent-device/kernel/errors';
import { runCmdSync } from '@agent-device/host-kit/command';
import { mkdtempForTestSync } from '@agent-device/test-kit';

function makeUploadRequest(body: Buffer, headers: Record<string, string>): IncomingMessage {
  return Object.assign(Readable.from(body), { headers }) as IncomingMessage;
}

test('receiveUpload rejects uploads that exceed the configured content-length limit', async () => {
  const req = makeUploadRequest(Buffer.alloc(0), {
    'x-artifact-type': 'file',
    'x-artifact-filename': 'Sample.apk',
    'content-length': String(2 * 1024 * 1024 * 1024 + 1),
  });

  await assert.rejects(async () => await receiveUpload(req), /Upload exceeds maximum size/i);
});

test('receiveUpload verifies x-artifact-hash and removes its temp dir on mismatch', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-upload-hash-');
  const previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = tempRoot;
  try {
    const body = Buffer.from('apk-bytes');
    const headers = {
      'x-artifact-type': 'file',
      'x-artifact-filename': 'Sample.apk',
      'x-artifact-hash-algorithm': 'sha256',
    };
    await assert.rejects(
      receiveUpload(
        makeUploadRequest(body, { ...headers, 'x-artifact-hash': sha256(Buffer.from('other')) }),
      ),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
    );
    assert.deepEqual(fs.readdirSync(tempRoot), []);

    const upload = await receiveUpload(
      makeUploadRequest(body, { ...headers, 'x-artifact-hash': sha256(body).toUpperCase() }),
    );
    assert.equal(fs.readFileSync(upload.artifactPath, 'utf8'), 'apk-bytes');
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('receiveUpload cancels post-body work when its ingress owner fires at body completion', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-upload-owned-');
  const previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = tempRoot;
  try {
    const body = Buffer.from('owned-bytes');
    const controller = new AbortController();
    const typed = new AppError('COMMAND_FAILED', 'Upload transfer deadline exceeded', {
      reason: 'transfer_ingress_deadline_exceeded',
      transferPhase: 'request-body',
      timeoutMs: 600_000,
    });
    // The synthetic owner fires exactly when the body pipeline completes, before the
    // hash phase: the post-body work is owned, not admitted unbounded behind the cap.
    await assert.rejects(
      receiveUpload(
        makeUploadRequest(body, {
          'x-artifact-type': 'file',
          'x-artifact-filename': 'Sample.apk',
          'x-artifact-hash': sha256(body),
        }),
        {
          signal: controller.signal,
          onBodyComplete: () => controller.abort(typed),
        },
      ),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'transfer_ingress_deadline_exceeded',
    );
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('receiveUpload aborts an in-flight post-body hash under its ingress owner', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-upload-hash-abort-');
  const previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = tempRoot;
  try {
    // 64 MiB hashes across real I/O time, so the owner can fire mid-hash.
    const body = Buffer.alloc(64 * 1024 * 1024, 0x62);
    const controller = new AbortController();
    const typed = new AppError('COMMAND_FAILED', 'Upload body stalled', {
      reason: 'transfer_phase_timeout',
      transferPhase: 'request-body',
      timeoutMs: 120_000,
    });
    const upload = receiveUpload(
      makeUploadRequest(body, {
        'x-artifact-type': 'file',
        'x-artifact-filename': 'Sample.apk',
        'x-artifact-hash': sha256(body),
      }),
      {
        signal: controller.signal,
        onBodyComplete: () => {
          setTimeout(() => controller.abort(typed), 5);
        },
      },
    );
    await assert.rejects(
      upload,
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'transfer_phase_timeout',
    );
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('receiveUpload refuses a hash algorithm other than sha256', async () => {
  const req = makeUploadRequest(Buffer.from('apk-bytes'), {
    'x-artifact-type': 'file',
    'x-artifact-filename': 'Sample.apk',
    'x-artifact-hash': 'abc',
    'x-artifact-hash-algorithm': 'md5',
  });
  await assert.rejects(receiveUpload(req), /x-artifact-hash-algorithm/);
});

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

test('artifact content-length accepts decimal integers only', () => {
  for (const value of ['+1', '1e3', '0x10', '1.5', '-1']) {
    assert.throws(() => validateArtifactContentLength(value), value);
  }
  assert.doesNotThrow(() => validateArtifactContentLength('0'));
});

test('receiveUpload rejects app bundle archives containing symlinks', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-upload-archive-');
  const appDir = path.join(tempRoot, 'Sample.app');
  const targetFile = path.join(tempRoot, 'payload.txt');
  const archivePath = path.join(tempRoot, 'Sample.tar');

  try {
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(targetFile, 'payload');
    fs.symlinkSync('../payload.txt', path.join(appDir, 'linked.txt'));
    runCmdSync('tar', ['cf', archivePath, '-C', tempRoot, 'Sample.app']);

    const req = makeUploadRequest(fs.readFileSync(archivePath), {
      'x-artifact-type': 'app-bundle',
      'x-artifact-filename': 'Sample.app',
      'content-length': String(fs.statSync(archivePath).size),
    });

    await assert.rejects(
      async () => await receiveUpload(req),
      /cannot contain symlinks or hard links/i,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('receiveUpload extracts gzip-compressed app bundle archives', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-upload-gzip-');
  const appDir = path.join(tempRoot, 'Sample.app');
  const archivePath = path.join(tempRoot, 'Sample.tar.gz');

  try {
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'payload.txt'), 'payload');
    runCmdSync('tar', ['czf', archivePath, '-C', tempRoot, 'Sample.app'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const archive = fs.readFileSync(archivePath);
    const req = makeUploadRequest(archive, {
      'x-artifact-type': 'app-bundle',
      'x-artifact-filename': 'Sample.app',
      'content-type': 'application/gzip',
      'content-length': String(archive.length),
    });

    const upload = await receiveUpload(req);
    try {
      assert.equal(
        fs.readFileSync(path.join(upload.artifactPath, 'payload.txt'), 'utf8'),
        'payload',
      );
    } finally {
      fs.rmSync(upload.tempDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('streamReadableToFile removes partial files after stream errors', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-upload-error-');
  const destPath = path.join(tempRoot, 'partial.bin');
  const source = new Readable({
    read() {
      this.push('partial');
      this.destroy(new Error('source failed'));
    },
  });

  try {
    await assert.rejects(async () => await streamReadableToFile(source, destPath), /source failed/);
    assert.equal(fs.existsSync(destPath), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
