import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { AppError } from '@agent-device/kernel/errors';
import { extractTarInstallableArtifact } from './artifact-archive.ts';
import {
  createArtifactTempDir,
  sanitizeArtifactFilename,
  streamReadableToFile,
  validateArtifactContentLength,
} from './artifact-download.ts';
import { computeUploadHash } from './resumable-upload-transfer.ts';

export async function receiveUpload(
  req: IncomingMessage,
): Promise<{ artifactPath: string; tempDir: string }> {
  const artifactType = req.headers['x-artifact-type'] as string | undefined;
  const rawFilename = req.headers['x-artifact-filename'] as string | undefined;
  if (!artifactType || !rawFilename) {
    throw new AppError(
      'INVALID_ARGS',
      'Missing required headers: x-artifact-type and x-artifact-filename',
    );
  }
  if (artifactType !== 'file' && artifactType !== 'app-bundle') {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid x-artifact-type: ${artifactType}. Must be "file" or "app-bundle".`,
    );
  }

  validateArtifactContentLength(req.headers['content-length']);
  const expectedSha256 = readExpectedUploadSha256(req);
  const artifactFilename = sanitizeArtifactFilename(rawFilename);
  const tempDir = createArtifactTempDir('upload');
  try {
    if (artifactType === 'file') {
      const artifactPath = path.join(tempDir, artifactFilename);
      await streamReadableToFile(req, artifactPath);
      await verifyUploadSha256(artifactPath, expectedSha256);
      return { artifactPath, tempDir };
    }

    const archivePath = path.join(tempDir, 'artifact.tar');
    await streamReadableToFile(req, archivePath);
    await verifyUploadSha256(archivePath, expectedSha256);
    const artifactPath = await extractTarInstallableArtifact({
      archivePath,
      tempDir,
      platform: 'ios',
      expectedRootName: artifactFilename,
    });
    fs.rmSync(archivePath, { force: true });
    return { artifactPath, tempDir };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function readExpectedUploadSha256(req: IncomingMessage): string | undefined {
  const hash = req.headers['x-artifact-hash'];
  if (hash === undefined) return undefined;
  const algorithm = req.headers['x-artifact-hash-algorithm'] ?? 'sha256';
  if (algorithm !== 'sha256') {
    throw new AppError('INVALID_ARGS', `Unsupported x-artifact-hash-algorithm: ${algorithm}`);
  }
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) {
    throw new AppError('INVALID_ARGS', 'Invalid x-artifact-hash header');
  }
  return hash.toLowerCase();
}

async function verifyUploadSha256(
  payloadPath: string,
  expectedSha256: string | undefined,
): Promise<void> {
  if (expectedSha256 === undefined) return;
  const actualSha256 = await computeUploadHash(payloadPath);
  if (actualSha256 !== expectedSha256) {
    throw new AppError('INVALID_ARGS', 'Upload hash mismatch', { expectedSha256, actualSha256 });
  }
}
