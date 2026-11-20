import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { AppError } from '@agent-device/kernel/errors';
import {
  MAX_ARTIFACT_COMPRESSED_BYTES,
  createByteLimitStream,
} from '@agent-device/host-kit/archive';
import { extractTarInstallableArtifact } from './artifact-archive.ts';
import {
  createArtifactTempDir,
  sanitizeArtifactFilename,
  validateArtifactContentLength,
} from './artifact-download.ts';
import {
  computeUploadHash,
  observeAcceptedWrites,
  pipeRequestBody,
} from './resumable-upload-transfer.ts';
import { resolveIngressFailure, throwIfIngressAborted } from './upload-ingress.ts';

/**
 * The ingress owner a single-shot upload runs under (#4441): its signal aborts the joined
 * body pipeline with a typed reason, owns the post-body hash and extraction, and its
 * inactivity ceiling renews only on accepted (flushed) body bytes until the body completes.
 */
export type UploadIngressLink = {
  signal?: AbortSignal;
  onBodyBytes?: (bytes: number) => void;
  onBodyComplete?: () => void;
};

export async function receiveUpload(
  req: IncomingMessage,
  ingress?: UploadIngressLink,
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
      await receiveUploadBody(req, artifactPath, ingress);
      // Hashing reads only the bounded file just received under the ingress owner's
      // signal; the check keeps an already-fired owner authoritative even when no
      // hash header was sent.
      throwIfIngressAborted(ingress?.signal);
      await verifyUploadSha256(artifactPath, expectedSha256, ingress?.signal);
      return { artifactPath, tempDir };
    }

    const archivePath = path.join(tempDir, 'artifact.tar');
    await receiveUploadBody(req, archivePath, ingress);
    throwIfIngressAborted(ingress?.signal);
    await verifyUploadSha256(archivePath, expectedSha256, ingress?.signal);
    throwIfIngressAborted(ingress?.signal);
    // Extraction reads only the archive just received, which the body pipeline capped
    // at MAX_ARTIFACT_COMPRESSED_BYTES; the owner's signal destroys the extraction
    // stream mid-phase instead of admitting unbounded work behind the byte cap.
    const artifactPath = await extractTarInstallableArtifact({
      archivePath,
      tempDir,
      platform: 'ios',
      expectedRootName: artifactFilename,
      signal: ingress?.signal,
    });
    fs.rmSync(archivePath, { force: true });
    return { artifactPath, tempDir };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw resolveIngressFailure(ingress?.signal, error);
  }
}

/**
 * One joined pipeline for the request body, owned by the ingress link: the signal
 * destroys every pipeline stream with its typed reason (the earliest failure wins) but
 * never the request itself, each
 * accepted (flushed) byte renews the owner's inactivity ceiling, and the ceiling stops
 * at body completion so post-body work observes only the aggregate. The byte cap keeps
 * the later local phases (hash, extract) bounded by the same limit.
 */
async function receiveUploadBody(
  req: IncomingMessage,
  destPath: string,
  ingress?: UploadIngressLink,
): Promise<void> {
  const byteLimit = createByteLimitStream({
    maxBytes: MAX_ARTIFACT_COMPRESSED_BYTES,
    createLimitError: () =>
      new AppError(
        'INVALID_ARGS',
        `Upload exceeds maximum size of ${MAX_ARTIFACT_COMPRESSED_BYTES} bytes`,
      ),
  });
  const output = fs.createWriteStream(destPath);
  observeAcceptedWrites(output, ingress?.onBodyBytes);
  try {
    await pipeRequestBody(req, byteLimit, output, ingress?.signal);
    ingress?.onBodyComplete?.();
  } catch (error) {
    throw resolveIngressFailure(ingress?.signal, error);
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
  signal?: AbortSignal,
): Promise<void> {
  if (expectedSha256 === undefined) return;
  const actualSha256 = await computeUploadHash(payloadPath, signal);
  if (actualSha256 !== expectedSha256) {
    throw new AppError('INVALID_ARGS', 'Upload hash mismatch', { expectedSha256, actualSha256 });
  }
}
