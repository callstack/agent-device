import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { AppError } from '@agent-device/kernel/errors';
import { extractTarInstallableArtifact } from './artifact-archive.ts';
import { requireTenantOwnedEntry, type TenantOwnedResourceKind } from './tenant-owned-entry.ts';
import {
  createArtifactTempDir,
  sanitizeArtifactFilename,
  validateArtifactContentLength,
} from './artifact-download.ts';
import { computeUploadHash, receiveResumableTransfer } from './resumable-upload-transfer.ts';

const RESUMABLE_UPLOAD_CLEANUP_TIMEOUT_MS = 5 * 60 * 1000;
const RESUMABLE_UPLOAD_RESOURCE: TenantOwnedResourceKind = {
  label: 'Upload',
  expiredHint: `Resumable uploads expire ${RESUMABLE_UPLOAD_CLEANUP_TIMEOUT_MS / 60_000} minutes after the last received chunk. Start the upload again from the beginning.`,
};
const RESUMABLE_UPLOADS_BY_ID = new Map<string, ResumableUploadEntry>();
const RESUMABLE_UPLOADS_BY_KEY = new Map<string, string>();

export type BeginResumableUploadOptions = {
  baseUrl: string;
  tokenHeaders: Record<string, string>;
  uploadAttemptId: string;
  sha256: string;
  fileName: string;
  sizeBytes: number;
  artifactType: 'file' | 'app-bundle';
  platform?: string;
  contentType?: string;
  tenantId?: string;
};

type ResumableUploadEntry = {
  id: string;
  key: string;
  tempDir: string;
  payloadPath: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  artifactType: 'file' | 'app-bundle';
  platform?: string;
  tenantId?: string;
  timer?: ReturnType<typeof setTimeout>;
  generation: number;
  tail: Promise<void>;
  activeReceive?: IncomingMessage;
  closed: boolean;
  finalized: boolean;
};

export function beginResumableUpload(options: BeginResumableUploadOptions): {
  uploadId: string;
  cacheHit: false;
  upload: { url: string; headers: Record<string, string> };
} {
  validateResumableUploadOptions(options);
  const key = buildResumableUploadKey(options);
  const existingId = RESUMABLE_UPLOADS_BY_KEY.get(key);
  const existing = existingId ? RESUMABLE_UPLOADS_BY_ID.get(existingId) : undefined;
  const entry = existing ?? createResumableUploadEntry(options, key);
  return {
    uploadId: entry.id,
    cacheHit: false,
    upload: {
      url: new URL(
        `upload/direct/${entry.id}`,
        options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`,
      ).toString(),
      headers: {
        ...options.tokenHeaders,
        'content-type': options.contentType || 'application/octet-stream',
      },
    },
  };
}

export async function receiveResumableUploadChunk(params: {
  uploadId: string;
  req: IncomingMessage;
  tenantId?: string;
}): Promise<{ complete: boolean; offset: number }> {
  const entry = requireResumableUpload(params.uploadId, params.tenantId);
  return await runExclusive(entry, 'receive', params.req, async () => {
    const { appended, ...result } = await receiveResumableTransfer({
      entry,
      req: params.req,
      invalidate: async () => await terminateEntry(entry),
    });
    if (appended && !entry.closed) refreshResumableUploadTimer(entry);
    return result;
  });
}

export async function finalizeResumableUpload(
  uploadId: string,
  tenantId?: string,
): Promise<{ artifactPath: string; tempDir: string }> {
  const entry = requireResumableUpload(uploadId, tenantId);
  return await runExclusive(entry, 'finalize', undefined, async () => {
    const offset = fs.statSync(entry.payloadPath).size;
    if (offset !== entry.sizeBytes) {
      throw new AppError('INVALID_ARGS', 'Upload is incomplete', {
        uploadId,
        offset,
        sizeBytes: entry.sizeBytes,
      });
    }
    try {
      const actualHash = await computeUploadHash(entry.payloadPath);
      if (actualHash !== entry.sha256) {
        throw new AppError('INVALID_ARGS', 'Upload hash mismatch', {
          uploadId,
          expectedSha256: entry.sha256,
          actualSha256: actualHash,
        });
      }
      const artifactPath = await materializeFinalArtifact(entry);
      markFinalized(entry);
      return { artifactPath, tempDir: entry.tempDir };
    } catch (error) {
      throw await cleanupTerminalFinalizeFailure(entry, error);
    }
  });
}

function createResumableUploadEntry(
  options: BeginResumableUploadOptions,
  key: string,
): ResumableUploadEntry {
  const id = crypto.randomUUID();
  const tempDir = createArtifactTempDir('upload');
  const payloadPath = path.join(tempDir, 'payload');
  fs.writeFileSync(payloadPath, '');
  const entry: ResumableUploadEntry = {
    id,
    key,
    tempDir,
    payloadPath,
    fileName: sanitizeArtifactFilename(options.fileName),
    sizeBytes: options.sizeBytes,
    sha256: options.sha256.toLowerCase(),
    artifactType: options.artifactType,
    platform: options.platform,
    tenantId: options.tenantId,
    generation: 0,
    tail: Promise.resolve(),
    closed: false,
    finalized: false,
  };
  RESUMABLE_UPLOADS_BY_ID.set(id, entry);
  RESUMABLE_UPLOADS_BY_KEY.set(key, id);
  refreshResumableUploadTimer(entry);
  return entry;
}

function refreshResumableUploadTimer(entry: ResumableUploadEntry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.generation += 1;
  const generation = entry.generation;
  entry.timer = setTimeout(
    () => expireEntry(entry, generation),
    RESUMABLE_UPLOAD_CLEANUP_TIMEOUT_MS,
  );
  entry.timer.unref();
}

function expireEntry(entry: ResumableUploadEntry, generation: number): void {
  if (entry.generation !== generation || entry.closed) return;
  closeEntry(entry);
  const activeReceive = entry.activeReceive;
  activeReceive?.once('error', () => {});
  activeReceive?.destroy(
    new AppError('COMMAND_FAILED', 'Upload expired while receiving data', {
      reason: 'RESOURCE_EXPIRED',
    }),
  );
  const cleanup = entry.tail.then(async () => {
    if (!entry.finalized) await fs.promises.rm(entry.tempDir, { recursive: true, force: true });
  });
  entry.tail = cleanup.catch(() => {});
}

async function runExclusive<T>(
  entry: ResumableUploadEntry,
  kind: 'receive' | 'finalize',
  req: IncomingMessage | undefined,
  action: () => Promise<T>,
): Promise<T> {
  const operation = entry.tail
    .catch(() => {})
    .then(async () => {
      if (entry.closed) requireResumableUpload(entry.id, entry.tenantId);
      if (kind === 'receive') entry.activeReceive = req;
      try {
        return await action();
      } finally {
        if (kind === 'receive') entry.activeReceive = undefined;
      }
    });
  entry.tail = operation.then(
    () => {},
    () => {},
  );
  return await operation;
}

async function materializeFinalArtifact(entry: ResumableUploadEntry): Promise<string> {
  if (entry.artifactType === 'file') {
    const artifactPath = path.join(entry.tempDir, entry.fileName);
    await fs.promises.rename(entry.payloadPath, artifactPath);
    return artifactPath;
  }
  const artifactPath = await extractTarInstallableArtifact({
    archivePath: entry.payloadPath,
    tempDir: entry.tempDir,
    platform: entry.platform === 'android' ? 'android' : 'ios',
    expectedRootName: entry.fileName,
  });
  await fs.promises.rm(entry.payloadPath, { force: true });
  return artifactPath;
}

function markFinalized(entry: ResumableUploadEntry): void {
  entry.finalized = true;
  closeEntry(entry);
}

async function cleanupTerminalFinalizeFailure(
  entry: ResumableUploadEntry,
  originalError: unknown,
): Promise<unknown> {
  closeEntry(entry);
  try {
    await fs.promises.rm(entry.tempDir, { recursive: true, force: true });
    return originalError;
  } catch (cleanupError) {
    return new AppError(
      'COMMAND_FAILED',
      'Upload finalize cleanup failed',
      { reason: 'UPLOAD_FINALIZE_CLEANUP_FAILED', originalError: String(originalError) },
      cleanupError,
    );
  }
}

async function terminateEntry(entry: ResumableUploadEntry): Promise<void> {
  closeEntry(entry);
  await fs.promises.rm(entry.tempDir, { recursive: true, force: true }).catch(() => {});
}

function closeEntry(entry: ResumableUploadEntry): void {
  entry.closed = true;
  if (entry.timer) clearTimeout(entry.timer);
  RESUMABLE_UPLOADS_BY_ID.delete(entry.id);
  RESUMABLE_UPLOADS_BY_KEY.delete(entry.key);
}

function requireResumableUpload(
  uploadId: string,
  tenantId: string | undefined,
): ResumableUploadEntry {
  return requireTenantOwnedEntry(
    RESUMABLE_UPLOADS_BY_ID,
    uploadId,
    tenantId,
    RESUMABLE_UPLOAD_RESOURCE,
  );
}

function validateResumableUploadOptions(options: BeginResumableUploadOptions): void {
  if (!/^[a-f0-9]{64}$/i.test(options.sha256)) {
    throw new AppError('INVALID_ARGS', 'Invalid upload sha256');
  }
  if (!Number.isSafeInteger(options.sizeBytes) || options.sizeBytes < 0) {
    throw new AppError('INVALID_ARGS', 'Invalid upload sizeBytes');
  }
  validateArtifactContentLength(String(options.sizeBytes));
  sanitizeArtifactFilename(options.fileName);
  if (!options.uploadAttemptId.trim()) {
    throw new AppError('INVALID_ARGS', 'uploadAttemptId is required');
  }
}

function buildResumableUploadKey(options: BeginResumableUploadOptions): string {
  return [
    options.tenantId ?? '',
    options.uploadAttemptId,
    options.sha256.toLowerCase(),
    String(options.sizeBytes),
    sanitizeArtifactFilename(options.fileName),
    options.artifactType,
    options.platform ?? '',
  ].join('\0');
}
