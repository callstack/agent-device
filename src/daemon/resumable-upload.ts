import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../kernel/errors.ts';
import { extractTarInstallableArtifact } from './artifact-archive.ts';
import { requireTenantOwnedEntry, type TenantOwnedResourceKind } from './tenant-owned-entry.ts';
import {
  createArtifactTempDir,
  sanitizeArtifactFilename,
  validateArtifactContentLength,
} from './artifact-download.ts';

const RESUMABLE_UPLOAD_CLEANUP_TIMEOUT_MS = 5 * 60 * 1000;

const RESUMABLE_UPLOAD_RESOURCE: TenantOwnedResourceKind = {
  label: 'Upload',
  expiredHint: `Resumable uploads expire ${RESUMABLE_UPLOAD_CLEANUP_TIMEOUT_MS / 60_000} minutes after the last received chunk. Start the upload again from the beginning.`,
};
const RESUMABLE_UPLOAD_HASH_ALGORITHM = 'sha256';
const RESUMABLE_UPLOADS_BY_ID = new Map<string, ResumableUploadEntry>();
const RESUMABLE_UPLOADS_BY_KEY = new Map<string, string>();

type UploadArtifactType = 'file' | 'app-bundle';

export type BeginResumableUploadOptions = {
  baseUrl: string;
  tokenHeaders: Record<string, string>;
  uploadAttemptId: string;
  sha256: string;
  fileName: string;
  sizeBytes: number;
  artifactType: UploadArtifactType;
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
  artifactType: UploadArtifactType;
  platform?: string;
  tenantId?: string;
  timer: ReturnType<typeof setTimeout>;
};

export function beginResumableUpload(options: BeginResumableUploadOptions): {
  uploadId: string;
  cacheHit: false;
  upload: {
    url: string;
    headers: Record<string, string>;
  };
} {
  validateResumableUploadOptions(options);
  const key = buildResumableUploadKey(options);
  const existingId = RESUMABLE_UPLOADS_BY_KEY.get(key);
  const existing = existingId ? RESUMABLE_UPLOADS_BY_ID.get(existingId) : undefined;
  const entry = existing ?? createResumableUploadEntry(options, key);
  refreshResumableUploadTimer(entry);

  return {
    uploadId: entry.id,
    cacheHit: false,
    upload: {
      url: new URL(`upload/direct/${entry.id}`, ensureTrailingSlash(options.baseUrl)).toString(),
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
  const currentOffset = currentResumableUploadOffset(entry);
  const contentRange = parseContentRange(params.req.headers['content-range'], entry.sizeBytes);
  if (contentRange && contentRange.start !== currentOffset) {
    return { complete: false, offset: currentOffset };
  }
  if (!contentRange && currentOffset > 0) {
    return { complete: false, offset: currentOffset };
  }

  validateArtifactContentLength(params.req.headers['content-length']);
  await pipeline(params.req, fs.createWriteStream(entry.payloadPath, { flags: 'a' }));
  refreshResumableUploadTimer(entry);

  const offset = currentResumableUploadOffset(entry);
  return { complete: offset >= entry.sizeBytes, offset };
}

export async function finalizeResumableUpload(
  uploadId: string,
  tenantId?: string,
): Promise<{ artifactPath: string; tempDir: string }> {
  const entry = requireResumableUpload(uploadId, tenantId);
  const offset = currentResumableUploadOffset(entry);
  if (offset !== entry.sizeBytes) {
    throw new AppError('INVALID_ARGS', 'Upload is incomplete', {
      uploadId,
      offset,
      sizeBytes: entry.sizeBytes,
    });
  }
  const actualHash = await computeFileHash(entry.payloadPath);
  if (actualHash !== entry.sha256) {
    cleanupResumableUpload(entry.id);
    throw new AppError('INVALID_ARGS', 'Upload hash mismatch', {
      uploadId,
      expectedSha256: entry.sha256,
      actualSha256: actualHash,
    });
  }

  RESUMABLE_UPLOADS_BY_ID.delete(entry.id);
  RESUMABLE_UPLOADS_BY_KEY.delete(entry.key);
  clearTimeout(entry.timer);

  if (entry.artifactType === 'file') {
    const artifactPath = path.join(entry.tempDir, entry.fileName);
    fs.renameSync(entry.payloadPath, artifactPath);
    return { artifactPath, tempDir: entry.tempDir };
  }

  const artifactPath = await extractTarInstallableArtifact({
    archivePath: entry.payloadPath,
    tempDir: entry.tempDir,
    platform: entry.platform === 'android' ? 'android' : 'ios',
    expectedRootName: entry.fileName,
  });
  fs.rmSync(entry.payloadPath, { force: true });
  return { artifactPath, tempDir: entry.tempDir };
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

function createResumableUploadEntry(
  options: BeginResumableUploadOptions,
  key: string,
): ResumableUploadEntry {
  const id = crypto.randomUUID();
  const tempDir = createArtifactTempDir('upload');
  const entry: ResumableUploadEntry = {
    id,
    key,
    tempDir,
    payloadPath: path.join(tempDir, 'payload'),
    fileName: sanitizeArtifactFilename(options.fileName),
    sizeBytes: options.sizeBytes,
    sha256: options.sha256.toLowerCase(),
    artifactType: options.artifactType,
    platform: options.platform,
    tenantId: options.tenantId,
    timer: setTimeout(() => cleanupResumableUpload(id), RESUMABLE_UPLOAD_CLEANUP_TIMEOUT_MS),
  };
  entry.timer.unref();
  RESUMABLE_UPLOADS_BY_ID.set(id, entry);
  RESUMABLE_UPLOADS_BY_KEY.set(key, id);
  return entry;
}

function refreshResumableUploadTimer(entry: ResumableUploadEntry): void {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(
    () => cleanupResumableUpload(entry.id),
    RESUMABLE_UPLOAD_CLEANUP_TIMEOUT_MS,
  );
  entry.timer.unref();
}

function cleanupResumableUpload(uploadId: string): void {
  const entry = RESUMABLE_UPLOADS_BY_ID.get(uploadId);
  if (!entry) return;
  clearTimeout(entry.timer);
  RESUMABLE_UPLOADS_BY_ID.delete(uploadId);
  RESUMABLE_UPLOADS_BY_KEY.delete(entry.key);
  fs.rmSync(entry.tempDir, { recursive: true, force: true });
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

function currentResumableUploadOffset(entry: ResumableUploadEntry): number {
  if (!fs.existsSync(entry.payloadPath)) return 0;
  return Math.min(fs.statSync(entry.payloadPath).size, entry.sizeBytes);
}

function parseContentRange(
  value: string | string[] | undefined,
  sizeBytes: number,
): { start: number; end: number } | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const range = readContentRange(raw);
  if (!range || !isValidContentRange(range, sizeBytes)) {
    throw new AppError('INVALID_ARGS', 'Invalid content-range header');
  }
  return { start: range.start, end: range.end };
}

function readContentRange(raw: string): { start: number; end: number; size: number } | null {
  const match = raw.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    size: Number(match[3]),
  };
}

function isValidContentRange(
  range: { start: number; end: number; size: number },
  sizeBytes: number,
): boolean {
  return (
    Number.isSafeInteger(range.start) &&
    Number.isSafeInteger(range.end) &&
    Number.isSafeInteger(range.size) &&
    range.start >= 0 &&
    range.end >= range.start &&
    range.size === sizeBytes
  );
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

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

async function computeFileHash(filePath: string): Promise<string> {
  const hash = crypto.createHash(RESUMABLE_UPLOAD_HASH_ALGORITHM);
  await pipeline(fs.createReadStream(filePath), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk);
      yield chunk;
    }
  });
  return hash.digest('hex');
}
