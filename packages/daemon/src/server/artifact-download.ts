import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { MAX_ARTIFACT_COMPRESSED_BYTES } from '@agent-device/host-kit/archive';

const TEMP_PREFIX = 'agent-device-artifact-';

export function sanitizeArtifactFilename(raw: string): string {
  const trimmed = raw.trim();
  const basename = path.basename(trimmed);
  if (!basename || basename === '.' || basename === '..') {
    throw new AppError('INVALID_ARGS', `Invalid artifact filename: ${raw}`);
  }
  return basename;
}

export function createArtifactTempDir(requestId?: string): string {
  const scope = sanitizeRequestId(requestId);
  return fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${scope}-`));
}

export function validateArtifactContentLength(rawLength: string | number | undefined): void {
  if (rawLength === undefined) return;
  const raw = String(rawLength);
  if (!/^\d+$/.test(raw)) {
    throw new AppError('INVALID_ARGS', 'Invalid content-length header');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new AppError('INVALID_ARGS', 'Invalid content-length header');
  }
  if (parsed > MAX_ARTIFACT_COMPRESSED_BYTES) {
    throw new AppError(
      'INVALID_ARGS',
      `Upload exceeds maximum size of ${MAX_ARTIFACT_COMPRESSED_BYTES} bytes`,
    );
  }
}

function sanitizeRequestId(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return 'request';
  const normalized = trimmed.replaceAll(/[^a-zA-Z0-9._-]+/g, '-').replaceAll(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized.slice(0, 48) : 'request';
}
