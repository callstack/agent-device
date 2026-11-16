import type { EnvMap } from '@agent-device/kernel/source-value';
import { randomUUID } from 'node:crypto';
import { AppError } from '@agent-device/kernel/errors';
import {
  buildDaemonHttpAuthHeaders,
  buildDaemonHttpLeaseHeaders,
} from '@agent-device/contracts/daemon-http';
import { prepareUploadArtifact, type PreparedUploadArtifact } from './upload-client-artifact.ts';
import {
  isRetryableUploadStreamError,
  streamFileToHttpRequest,
  withUploadPreparationDeadline,
} from './upload-stream.ts';
import type { UploadProgressSink } from './upload-progress.ts';
import {
  createTransferPhaseWatchdog,
  isTransferPhaseTimeoutError,
} from '@agent-device/host-kit/transport';

/** Ceiling for the small JSON `preflight` and `finalize` calls that bracket an upload. */
const UPLOAD_CONTROL_PLANE_TIMEOUT_MS = 30_000;

const ARTIFACT_HASH_ALGORITHM = 'sha256';

type UploadArtifactOptions = {
  localPath: string;
  baseUrl: string;
  token: string;
  platform?: string;
  /** The environment a packaging command (`tar`) starts from. */
  env: Readonly<EnvMap>;
  /** The lease this upload is for; every request to the daemon names it in a header. */
  leaseId?: string;
  onProgress?: UploadProgressSink;
  /**
   * Ends the upload when the thing it is uploading for stops being worth finishing — today, a beat
   * that found the device's lease gone. Aborted requests reject with the signal's own reason.
   */
  signal?: AbortSignal;
};

type UploadResponse = {
  ok: boolean;
  uploadId: string;
};

type UploadPreflightResponse = {
  ok: boolean;
  cacheHit?: boolean;
  uploadId?: string;
  upload?: {
    url?: string;
    headers?: Record<string, string>;
  };
};

type UploadPreflightResult =
  | {
      kind: 'cache-hit';
      uploadId: string;
    }
  | {
      kind: 'direct-upload';
      uploadId: string;
      url: string;
      headers: Record<string, string>;
    };

export async function uploadArtifact(options: UploadArtifactOptions): Promise<string> {
  return await withUploadPreparationDeadline(
    options.signal,
    async (signal) => await uploadArtifactWithinBudget({ ...options, signal }),
  );
}

async function uploadArtifactWithinBudget(
  options: UploadArtifactOptions & { signal: AbortSignal },
): Promise<string> {
  const prepared = await prepareUploadArtifact(
    options.localPath,
    options.platform,
    options.env,
    options.signal,
  );
  const normalizedBase = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
  const uploadAttemptId = randomUUID();

  try {
    const preflight = await requestUploadPreflight({
      normalizedBase,
      token: options.token,
      leaseId: options.leaseId,
      artifact: prepared,
      uploadAttemptId,
      signal: options.signal,
    });

    if (preflight?.kind === 'cache-hit') {
      return preflight.uploadId;
    }
    if (preflight?.kind === 'direct-upload') {
      const directUpload = await tryDirectUploadWithResume({
        normalizedBase,
        token: options.token,
        leaseId: options.leaseId,
        artifact: prepared,
        preflight,
        uploadAttemptId,
        onProgress: options.onProgress,
        signal: options.signal,
      });
      if (directUpload) return directUpload;
      options.onProgress?.({
        type: 'fallback',
        from: 'direct',
        to: 'legacy',
        fileName: prepared.fileName,
      });
      return await uploadLegacyArtifact({
        normalizedBase,
        token: options.token,
        leaseId: options.leaseId,
        artifact: prepared,
        onProgress: options.onProgress,
        signal: options.signal,
      });
    }

    return await uploadLegacyArtifact({
      normalizedBase,
      token: options.token,
      leaseId: options.leaseId,
      artifact: prepared,
      onProgress: options.onProgress,
      signal: options.signal,
    });
  } finally {
    prepared.cleanup();
  }
}

async function tryDirectUploadWithResume(options: {
  normalizedBase: string;
  token: string;
  leaseId?: string;
  artifact: PreparedUploadArtifact;
  preflight: Extract<UploadPreflightResult, { kind: 'direct-upload' }>;
  uploadAttemptId: string;
  onProgress?: UploadProgressSink;
  signal: AbortSignal;
}): Promise<string | undefined> {
  const uploadOnce = async (
    preflight: Extract<UploadPreflightResult, { kind: 'direct-upload' }>,
  ): Promise<string> => {
    await uploadDirectArtifact(options, preflight);
    return await finalizeDirectUpload({
      normalizedBase: options.normalizedBase,
      token: options.token,
      leaseId: options.leaseId,
      uploadId: preflight.uploadId,
      signal: options.signal,
    });
  };

  try {
    return await uploadOnce(options.preflight);
  } catch (error) {
    // A canceled upload resumes for no reason: the thing it was uploaded for is already gone, and
    // re-preflighting would ask the daemon for a fresh ticket to send bytes nobody is waiting on.
    if (options.signal.aborted) throw error;
    // An expired phase is this client's own deadline, never a transport break to retry.
    if (isTransferPhaseTimeoutError(error)) throw error;
    if (!shouldRetryDirectUpload(error)) return undefined;
    return await retryDirectUpload(options, uploadOnce);
  }
}

/**
 * One fresh attempt after a retryable stream failure, asked for under the same attempt id.
 *
 * Anything short of a usable ticket — a cache hit excepted, which is itself a finished upload —
 * hands the caller back to the legacy path. A second failure is not retried again: a ticket that
 * failed twice is a transport or ticket problem the legacy route may still survive.
 */
async function retryDirectUpload(
  options: {
    normalizedBase: string;
    token: string;
    leaseId?: string;
    artifact: PreparedUploadArtifact;
    uploadAttemptId: string;
    onProgress?: UploadProgressSink;
    signal: AbortSignal;
  },
  uploadOnce: (
    preflight: Extract<UploadPreflightResult, { kind: 'direct-upload' }>,
  ) => Promise<string>,
): Promise<string | undefined> {
  const retryPreflight = await requestUploadPreflight({
    normalizedBase: options.normalizedBase,
    token: options.token,
    leaseId: options.leaseId,
    artifact: options.artifact,
    uploadAttemptId: options.uploadAttemptId,
    signal: options.signal,
  });
  if (retryPreflight?.kind === 'cache-hit') {
    return retryPreflight.uploadId;
  }
  if (retryPreflight?.kind === 'direct-upload') {
    try {
      return await uploadOnce(retryPreflight);
    } catch (error) {
      options.signal.throwIfAborted();
      if (isTransferPhaseTimeoutError(error)) throw error;
      return undefined;
    }
  }
  return undefined;
}

function shouldRetryDirectUpload(error: unknown): boolean {
  if (!(error instanceof AppError)) return true;
  return isRetryableUploadStreamError(error);
}

async function uploadLegacyArtifact(options: {
  normalizedBase: string;
  token: string;
  leaseId?: string;
  artifact: PreparedUploadArtifact;
  onProgress?: UploadProgressSink;
  signal: AbortSignal;
}): Promise<string> {
  const { normalizedBase, token, leaseId, artifact } = options;
  const uploadUrl = new URL('upload', normalizedBase);

  const headers: Record<string, string> = {
    'content-type': artifact.contentType,
    'x-artifact-type': artifact.artifactType,
    'x-artifact-filename': artifact.fileName,
    'x-artifact-hash': artifact.sha256,
    'x-artifact-hash-algorithm': ARTIFACT_HASH_ALGORITHM,
    'transfer-encoding': 'chunked',
  };
  Object.assign(headers, buildDaemonHttpAuthHeaders(token), buildDaemonHttpLeaseHeaders(leaseId));

  const response = await streamFileToHttpRequest({
    url: uploadUrl,
    method: 'POST',
    headers,
    payloadPath: artifact.payloadPath,
    errorMessage: 'Failed to upload artifact to remote daemon',
    errorHint: 'Verify the remote daemon is reachable and supports artifact uploads.',
    signal: options.signal,
    progress: {
      stage: 'legacy',
      fileName: artifact.fileName,
      onProgress: options.onProgress,
    },
  });

  try {
    const parsed = JSON.parse(response.body) as UploadResponse;
    if (!parsed.ok || !parsed.uploadId) {
      throw new AppError('COMMAND_FAILED', `Upload failed: ${response.body}`);
    }
    return parsed.uploadId;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('COMMAND_FAILED', `Invalid upload response: ${response.body}`);
  }
}

async function requestUploadPreflight(options: {
  normalizedBase: string;
  token: string;
  leaseId?: string;
  artifact: PreparedUploadArtifact;
  uploadAttemptId: string;
  signal?: AbortSignal;
}): Promise<UploadPreflightResult | undefined> {
  const preflightUrl = new URL('upload/preflight', options.normalizedBase);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  Object.assign(
    headers,
    buildDaemonHttpAuthHeaders(options.token),
    buildDaemonHttpLeaseHeaders(options.leaseId),
  );

  const result = await requestUploadControl(
    preflightUrl,
    {
      headers,
      body: JSON.stringify({
        uploadAttemptId: options.uploadAttemptId,
        sha256: options.artifact.sha256,
        fileName: options.artifact.fileName,
        sizeBytes: options.artifact.sizeBytes,
        artifactType: options.artifact.artifactType,
        ...(options.artifact.platform ? { platform: options.artifact.platform } : {}),
        contentType: options.artifact.contentType,
      }),
    },
    'preflight',
    options.signal,
  ).catch((error: unknown) => {
    // A failed preflight is ordinary here — the caller falls back to the legacy upload. A canceled
    // one is not: there is nothing to fall back to when the lease that paid for this upload is gone.
    if (options.signal?.aborted || isTransferPhaseTimeoutError(error)) throw error;
    return undefined;
  });

  if (!result?.response.ok) {
    return undefined;
  }

  return parseUploadPreflightResult(result.body);
}

async function requestUploadControl(
  url: URL,
  init: { headers: Record<string, string>; body: string },
  phase: 'preflight' | 'finalize',
  callerSignal?: AbortSignal,
): Promise<{ response: Response; body: unknown }> {
  const watchdog = createTransferPhaseWatchdog(callerSignal);
  watchdog.signal.throwIfAborted();
  watchdog.arm(phase, UPLOAD_CONTROL_PLANE_TIMEOUT_MS);
  try {
    // Redirects could forward the daemon token, so these control requests never follow them.
    const response = await fetch(url, {
      ...init,
      method: 'POST',
      redirect: 'error',
      signal: watchdog.signal,
    });
    const body: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
    watchdog.signal.throwIfAborted();
    return { response, body };
  } catch (error) {
    watchdog.signal.throwIfAborted();
    throw error;
  } finally {
    watchdog.dispose();
  }
}

function parseUploadPreflightResult(value: unknown): UploadPreflightResult | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const preflight = value as UploadPreflightResponse;
  if (preflight.ok !== true || typeof preflight.uploadId !== 'string') {
    return undefined;
  }
  if (preflight.cacheHit === true) {
    return {
      kind: 'cache-hit',
      uploadId: preflight.uploadId,
    };
  }

  const upload = preflight.upload;
  if (!upload || typeof upload.url !== 'string') {
    return undefined;
  }
  const headers = upload.headers ?? {};
  if (!isStringRecord(headers)) {
    return undefined;
  }
  return {
    kind: 'direct-upload',
    uploadId: preflight.uploadId,
    url: upload.url,
    headers,
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'string');
}

async function uploadDirectArtifact(
  options: {
    normalizedBase: string;
    leaseId?: string;
    artifact: PreparedUploadArtifact;
    onProgress?: UploadProgressSink;
    signal: AbortSignal;
  },
  ticket: Extract<UploadPreflightResult, { kind: 'direct-upload' }>,
): Promise<void> {
  const { artifact, onProgress, signal } = options;
  const url = new URL(ticket.url);
  const response = await streamFileToHttpRequest({
    url,
    method: 'PUT',
    // A ticket on the daemon's own origin is routed like any daemon request, so it names the lease
    // too; a ticket elsewhere (a signed storage URL) gets only the headers the daemon handed out.
    headers:
      url.origin === new URL(options.normalizedBase).origin
        ? { ...ticket.headers, ...buildDaemonHttpLeaseHeaders(options.leaseId) }
        : ticket.headers,
    payloadPath: artifact.payloadPath,
    errorMessage: 'Failed to upload artifact with direct upload ticket',
    retryable: true,
    signal,
    progress: {
      stage: 'direct',
      fileName: artifact.fileName,
      onProgress,
    },
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new AppError('COMMAND_FAILED', 'Direct artifact upload failed', {
      statusCode: response.statusCode,
      statusMessage: response.statusMessage,
    });
  }
}

async function finalizeDirectUpload(options: {
  normalizedBase: string;
  token: string;
  leaseId?: string;
  uploadId: string;
  signal?: AbortSignal;
}): Promise<string> {
  const finalizeUrl = new URL('upload/finalize', options.normalizedBase);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  Object.assign(
    headers,
    buildDaemonHttpAuthHeaders(options.token),
    buildDaemonHttpLeaseHeaders(options.leaseId),
  );

  const result = await requestUploadControl(
    finalizeUrl,
    {
      headers,
      body: JSON.stringify({ uploadId: options.uploadId }),
    },
    'finalize',
    options.signal,
  ).catch((error: unknown) => {
    // As with preflight: a canceled finalize is not a transport failure to report, it is the caller
    // saying this upload is no longer worth finishing.
    if (options.signal?.aborted || isTransferPhaseTimeoutError(error)) throw error;
    throw new AppError('COMMAND_FAILED', 'Failed to finalize direct artifact upload', {}, error);
  });

  if (!result.response.ok) {
    throw new AppError('COMMAND_FAILED', 'Direct artifact upload finalize failed', {
      status: result.response.status,
      statusText: result.response.statusText,
    });
  }

  const parsed = result.body as UploadResponse | undefined;
  if (!parsed?.ok || !parsed.uploadId) {
    throw new AppError('COMMAND_FAILED', 'Invalid upload finalize response');
  }
  return parsed.uploadId;
}
