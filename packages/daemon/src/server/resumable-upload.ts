import { runtimeSlot } from '@agent-device/host-kit/runtime-slots';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { AppError } from '@agent-device/kernel/errors';
import { awaitWithSignal } from '@agent-device/kernel/await-with-signal';
import { extractTarInstallableArtifact } from './artifact-archive.ts';
import {
  requireTenantOwnedEntry,
  type TenantOwnedResourceKind,
} from '../core/tenant-owned-entry.ts';
import {
  createArtifactTempDir,
  sanitizeArtifactFilename,
  validateArtifactContentLength,
} from './artifact-download.ts';
import { computeUploadHash, receiveResumableTransfer } from './resumable-upload-transfer.ts';
import { resolveIngressFailure, throwIfIngressAborted } from './upload-ingress.ts';

const RESUMABLE_UPLOAD_CLEANUP_TIMEOUT_MS = 5 * 60 * 1000;
const RESUMABLE_UPLOAD_RESOURCE: TenantOwnedResourceKind = {
  label: 'Upload',
  expiredHint: `Resumable uploads expire ${RESUMABLE_UPLOAD_CLEANUP_TIMEOUT_MS / 60_000} minutes after the last received chunk. Start the upload again from the beginning.`,
};
type ResumableUploadState = {
  byId: Map<string, ResumableUploadEntry>;
  byKey: Map<string, string>;
};

const RESUMABLE_UPLOAD_SLOT = Symbol('resumableUploads');
const resumableUploads = (): ResumableUploadState =>
  runtimeSlot(
    RESUMABLE_UPLOAD_SLOT,
    (): ResumableUploadState => ({ byId: new Map(), byKey: new Map() }),
    (state) => {
      for (const entry of state.byId.values()) {
        clearTimeout(entry.timer);
        try {
          fs.rmSync(entry.tempDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup only
        }
      }
    },
  );
const RESUMABLE_UPLOADS_BY_ID = () => resumableUploads().byId;
const RESUMABLE_UPLOADS_BY_KEY = () => resumableUploads().byKey;

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
  /** Aborts the active receive with the ticket's typed expiry. */
  activeReceive?: AbortController;
  closed: boolean;
  finalized: boolean;
};

type ResumableUploadTicket = {
  uploadId: string;
  cacheHit: false;
  upload: { url: string; headers: Record<string, string> };
};

/**
 * Returns the ticket for this upload attempt, creating it when none exists. With `publish`,
 * a newly created ticket is provisional until `publish` returns: when `publish` throws (a
 * refused commit), the new ticket and its directory are removed again. An existing ticket
 * returned for the same attempt is kept either way.
 */
export function beginResumableUpload(
  options: BeginResumableUploadOptions,
  publish?: (ticket: ResumableUploadTicket) => void,
): ResumableUploadTicket {
  validateResumableUploadOptions(options);
  const key = buildResumableUploadKey(options);
  const existingId = RESUMABLE_UPLOADS_BY_KEY().get(key);
  const existing = existingId ? RESUMABLE_UPLOADS_BY_ID().get(existingId) : undefined;
  const entry = existing ?? createResumableUploadEntry(options, key);
  const ticket = describeResumableUploadTicket(entry, options);
  if (!publish) return ticket;
  try {
    publish(ticket);
  } catch (error) {
    if (!existing) {
      closeEntry(entry);
      fs.rmSync(entry.tempDir, { recursive: true, force: true });
    }
    throw error;
  }
  return ticket;
}

function describeResumableUploadTicket(
  entry: ResumableUploadEntry,
  options: BeginResumableUploadOptions,
): ResumableUploadTicket {
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
  signal?: AbortSignal;
  /** The request owner's commit gate; the chunk offset commits through it. */
  commit?: <T>(work: () => T) => T;
  onAcceptedBytes?: (bytes: number) => void;
  onBodyComplete?: () => void;
}): Promise<{ complete: boolean; offset: number }> {
  const entry = requireResumableUpload(params.uploadId, params.tenantId);
  // The ticket's own expiry reaches the receive through this controller, never by
  // destroying the request: the request owner ends the exchange in response order.
  const ticketExpiry = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, ticketExpiry.signal])
    : ticketExpiry.signal;
  return await runExclusive(
    entry,
    'receive',
    ticketExpiry,
    async () => {
      const { appended, ...result } = await receiveResumableTransfer({
        entry,
        req: params.req,
        signal,
        commit: params.commit,
        invalidate: async () => await terminateEntry(entry),
        onAcceptedBytes: (bytes) => {
          // Accepted (flushed) body bytes renew the ticket's idle lifetime during
          // actual progress, not only when a whole chunk completes (#4441). The request
          // deadline is checked first, so an overdue write never extends the ticket.
          params.onAcceptedBytes?.(bytes);
          if (!entry.closed && !signal.aborted) refreshResumableUploadTimer(entry);
        },
        onBodyComplete: params.onBodyComplete,
      });
      if (appended && !entry.closed) refreshResumableUploadTimer(entry);
      return result;
    },
    params.signal,
  );
}

/**
 * The ingress owner a finalize runs under (#4441): its signal is threaded through the
 * serialized admission and into the post-body hash, the owned extraction stream, and
 * the artifact materialization, so expiry or client disconnect cancels that work with
 * the owner's typed reason instead of running it unbounded.
 */
export type FinalizeUploadIngressLink = {
  signal?: AbortSignal;
  /** The request owner's commit gate; each finalize step checks it. */
  commit?: <T>(work: () => T) => T;
};

export async function finalizeResumableUpload(
  uploadId: string,
  tenantId?: string,
  ingress?: FinalizeUploadIngressLink,
): Promise<{ artifactPath: string; tempDir: string }> {
  const entry = requireResumableUpload(uploadId, tenantId);
  const signal = ingress?.signal;
  // The owner's typed expiry, including a recorded deadline whose timer has not run yet.
  const ensureActive = () => {
    ingress?.commit?.(() => undefined);
    throwIfIngressAborted(signal);
  };
  return await runExclusive(
    entry,
    'finalize',
    undefined,
    async () => {
      // Admission of the serialized queue: an already-fired owner stays authoritative,
      // and a close/cancel that raced the wait keeps its own typed expiry error.
      ensureActive();
      // fs.statSync is inherently synchronous; the owner was checked immediately before.
      const offset = fs.statSync(entry.payloadPath).size;
      if (offset !== entry.sizeBytes) {
        // An incomplete finalize is not terminal: the ticket stays resumable and keeps
        // its original idle lifetime, so the timer is left armed exactly as it was (#4441).
        throw new AppError('INVALID_ARGS', 'Upload is incomplete', {
          uploadId,
          offset,
          sizeBytes: entry.sizeBytes,
        });
      }
      // A complete finalize is active work that owns the entry: disarm the idle timer so
      // expiry cannot fire during the post-write checks (hash, extraction, rename). Both
      // terminal outcomes close the entry and clean up through closeEntry (#4441).
      disarmResumableUploadTimer(entry);
      try {
        ensureActive();
        const actualHash = await computeUploadHash(entry.payloadPath, signal);
        if (actualHash !== entry.sha256) {
          throw new AppError('INVALID_ARGS', 'Upload hash mismatch', {
            uploadId,
            expectedSha256: entry.sha256,
            actualSha256: actualHash,
          });
        }
        ensureActive();
        const artifactPath = await materializeFinalArtifact(entry, signal);
        ensureActive();
        markFinalized(entry);
        return { artifactPath, tempDir: entry.tempDir };
      } catch (error) {
        // Joined cleanup runs on every terminal failure; the typed first failure —
        // including an abort-owned one mapped back to the owner's reason — is rethrown.
        throw await cleanupTerminalFinalizeFailure(entry, resolveIngressFailure(signal, error));
      }
    },
    signal,
  );
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
  RESUMABLE_UPLOADS_BY_ID().set(id, entry);
  RESUMABLE_UPLOADS_BY_KEY().set(key, id);
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

/**
 * Stops the idle timer without arming a new one and invalidates any in-flight fire,
 * for an operation (finalize) that owns the entry until it closes it.
 */
function disarmResumableUploadTimer(entry: ResumableUploadEntry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.generation += 1;
}

function expireEntry(entry: ResumableUploadEntry, generation: number): void {
  if (entry.generation !== generation || entry.closed) return;
  closeEntry(entry);
  entry.activeReceive?.abort(
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
  receive: AbortController | undefined,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const predecessor = entry.tail;
  const operation = (async () => {
    // Admission is abortable: an expired or disconnected waiter leaves the queue with the
    // owner's typed reason and never waits for a predecessor it does not own (#4441).
    await awaitWithSignal(
      predecessor.catch(() => {}),
      signal,
      () => {
        throwIfIngressAborted(signal);
      },
    );
    if (entry.closed) requireResumableUpload(entry.id, entry.tenantId);
    // The close check above runs first, so a close/cancel race keeps the close side's
    // typed expiry error, and the entry's ownership is untouched either way (#4441).
    throwIfIngressAborted(signal);
    if (kind === 'receive') entry.activeReceive = receive;
    try {
      return await action();
    } finally {
      if (kind === 'receive') entry.activeReceive = undefined;
    }
  })();
  // Later work waits for both the predecessor and this operation, so a released
  // waiter never lets its successor overlap the work still running ahead of it.
  entry.tail = Promise.allSettled([predecessor, operation]).then(() => {});
  return await operation;
}

async function materializeFinalArtifact(
  entry: ResumableUploadEntry,
  signal?: AbortSignal,
): Promise<string> {
  if (entry.artifactType === 'file') {
    const artifactPath = path.join(entry.tempDir, entry.fileName);
    // rename is a single non-cancellable filesystem operation; the owner is checked
    // immediately before it and the entry's cleanup still owns any failure.
    throwIfIngressAborted(signal);
    await fs.promises.rename(entry.payloadPath, artifactPath);
    return artifactPath;
  }
  const artifactPath = await extractTarInstallableArtifact({
    archivePath: entry.payloadPath,
    tempDir: entry.tempDir,
    platform: entry.platform === 'android' ? 'android' : 'ios',
    expectedRootName: entry.fileName,
    signal,
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
  RESUMABLE_UPLOADS_BY_ID().delete(entry.id);
  RESUMABLE_UPLOADS_BY_KEY().delete(entry.key);
}

function requireResumableUpload(
  uploadId: string,
  tenantId: string | undefined,
): ResumableUploadEntry {
  return requireTenantOwnedEntry(
    RESUMABLE_UPLOADS_BY_ID(),
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
