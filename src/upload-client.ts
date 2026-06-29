import { randomUUID } from 'node:crypto';
import { AppError } from './kernel/errors.ts';
import { buildDaemonHttpAuthHeaders } from './daemon/http-contract.ts';
import { prepareUploadArtifact, type PreparedUploadArtifact } from './upload-client-artifact.ts';
import { isRetryableUploadStreamError, streamFileToHttpRequest } from './upload-stream.ts';
import type { UploadProgressSink } from './upload-progress.ts';

const UPLOAD_PREFLIGHT_TIMEOUT_MS = 30 * 1000;
const ARTIFACT_HASH_ALGORITHM = 'sha256';

type UploadArtifactOptions = {
  localPath: string;
  baseUrl: string;
  token: string;
  platform?: string;
  onProgress?: UploadProgressSink;
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
  const prepared = await prepareUploadArtifact(options.localPath, options.platform);
  const normalizedBase = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
  const uploadAttemptId = randomUUID();

  try {
    const preflight = await requestUploadPreflight({
      normalizedBase,
      token: options.token,
      artifact: prepared,
      uploadAttemptId,
    });

    if (preflight?.kind === 'cache-hit') {
      return preflight.uploadId;
    }
    if (preflight?.kind === 'direct-upload') {
      const directUpload = await tryDirectUploadWithResume({
        normalizedBase,
        token: options.token,
        artifact: prepared,
        preflight,
        uploadAttemptId,
        onProgress: options.onProgress,
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
        artifact: prepared,
        onProgress: options.onProgress,
      });
    }

    return await uploadLegacyArtifact({
      normalizedBase,
      token: options.token,
      artifact: prepared,
      onProgress: options.onProgress,
    });
  } finally {
    prepared.cleanup();
  }
}

async function tryDirectUploadWithResume(options: {
  normalizedBase: string;
  token: string;
  artifact: PreparedUploadArtifact;
  preflight: Extract<UploadPreflightResult, { kind: 'direct-upload' }>;
  uploadAttemptId: string;
  onProgress?: UploadProgressSink;
}): Promise<string | undefined> {
  const uploadOnce = async (
    preflight: Extract<UploadPreflightResult, { kind: 'direct-upload' }>,
  ): Promise<string> => {
    await uploadDirectArtifact(options.artifact, preflight, options.onProgress);
    return await finalizeDirectUpload({
      normalizedBase: options.normalizedBase,
      token: options.token,
      uploadId: preflight.uploadId,
    });
  };

  try {
    return await uploadOnce(options.preflight);
  } catch (error) {
    if (!shouldRetryDirectUpload(error)) return undefined;
    const retryPreflight = await requestUploadPreflight({
      normalizedBase: options.normalizedBase,
      token: options.token,
      artifact: options.artifact,
      uploadAttemptId: options.uploadAttemptId,
    });
    if (retryPreflight?.kind === 'cache-hit') {
      return retryPreflight.uploadId;
    }
    if (retryPreflight?.kind === 'direct-upload') {
      try {
        return await uploadOnce(retryPreflight);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function shouldRetryDirectUpload(error: unknown): boolean {
  if (!(error instanceof AppError)) return true;
  return isRetryableUploadStreamError(error);
}

async function uploadLegacyArtifact(options: {
  normalizedBase: string;
  token: string;
  artifact: PreparedUploadArtifact;
  onProgress?: UploadProgressSink;
}): Promise<string> {
  const { normalizedBase, token, artifact } = options;
  const uploadUrl = new URL('upload', normalizedBase);

  const headers: Record<string, string> = {
    'content-type': artifact.contentType,
    'x-artifact-type': artifact.artifactType,
    'x-artifact-filename': artifact.fileName,
    'x-artifact-hash': artifact.sha256,
    'x-artifact-hash-algorithm': ARTIFACT_HASH_ALGORITHM,
    'transfer-encoding': 'chunked',
  };
  Object.assign(headers, buildDaemonHttpAuthHeaders(token));

  const response = await streamFileToHttpRequest({
    url: uploadUrl,
    method: 'POST',
    headers,
    payloadPath: artifact.payloadPath,
    timeoutMessage: 'Artifact upload timed out',
    timeoutHint: 'The upload to the remote daemon exceeded the 5-minute timeout.',
    errorMessage: 'Failed to upload artifact to remote daemon',
    errorHint: 'Verify the remote daemon is reachable and supports artifact uploads.',
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
  artifact: PreparedUploadArtifact;
  uploadAttemptId: string;
}): Promise<UploadPreflightResult | undefined> {
  const preflightUrl = new URL('upload/preflight', options.normalizedBase);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  Object.assign(headers, buildDaemonHttpAuthHeaders(options.token));

  const response = await fetch(preflightUrl, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(UPLOAD_PREFLIGHT_TIMEOUT_MS),
    body: JSON.stringify({
      uploadAttemptId: options.uploadAttemptId,
      sha256: options.artifact.sha256,
      fileName: options.artifact.fileName,
      sizeBytes: options.artifact.sizeBytes,
      artifactType: options.artifact.artifactType,
      ...(options.artifact.platform ? { platform: options.artifact.platform } : {}),
      contentType: options.artifact.contentType,
    }),
  }).catch(() => undefined);

  if (!response?.ok) {
    return undefined;
  }

  return parseUploadPreflightResult(await response.json().catch(() => undefined));
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
  artifact: PreparedUploadArtifact,
  ticket: Extract<UploadPreflightResult, { kind: 'direct-upload' }>,
  onProgress: UploadProgressSink | undefined,
): Promise<void> {
  const response = await streamFileToHttpRequest({
    url: new URL(ticket.url),
    method: 'PUT',
    headers: ticket.headers,
    payloadPath: artifact.payloadPath,
    timeoutMessage: 'Direct artifact upload timed out',
    timeoutHint: 'The direct upload ticket did not accept the artifact within the timeout.',
    errorMessage: 'Failed to upload artifact with direct upload ticket',
    retryable: true,
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
  uploadId: string;
}): Promise<string> {
  const finalizeUrl = new URL('upload/finalize', options.normalizedBase);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  Object.assign(headers, buildDaemonHttpAuthHeaders(options.token));

  const response = await fetch(finalizeUrl, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(UPLOAD_PREFLIGHT_TIMEOUT_MS),
    body: JSON.stringify({ uploadId: options.uploadId }),
  }).catch((error) => {
    throw new AppError('COMMAND_FAILED', 'Failed to finalize direct artifact upload', {}, error);
  });

  if (!response.ok) {
    throw new AppError('COMMAND_FAILED', 'Direct artifact upload finalize failed', {
      status: response.status,
      statusText: response.statusText,
    });
  }

  const parsed = (await response.json().catch(() => undefined)) as UploadResponse | undefined;
  if (!parsed?.ok || !parsed.uploadId) {
    throw new AppError('COMMAND_FAILED', 'Invalid upload finalize response');
  }
  return parsed.uploadId;
}
