import fs from 'node:fs';
import http from 'node:http';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from '../core/daemon-request.ts';
import { trackUploadedArtifact } from '../resources/artifact-tracking.ts';
import {
  type BeginResumableUploadOptions,
  beginResumableUpload,
  finalizeResumableUpload,
  receiveResumableUploadChunk,
} from './resumable-upload.ts';
import { receiveUpload } from './upload.ts';
import { sendRestJsonError } from './http-errors.ts';
import { beginUploadTransferIngress, type UploadTransferIngress } from './upload-ingress.ts';
import { readNodeHttpRequestBody } from '@agent-device/host-kit/transport';

const DIRECT_UPLOAD_PATH_PREFIX = '/upload/direct/';

type UploadHttpRoute =
  | { kind: 'upload' }
  | { kind: 'preflight' }
  | { kind: 'direct'; uploadId: string }
  | { kind: 'finalize' };

type UploadPreflightBody = Pick<
  BeginResumableUploadOptions,
  | 'artifactType'
  | 'contentType'
  | 'fileName'
  | 'platform'
  | 'sha256'
  | 'sizeBytes'
  | 'uploadAttemptId'
>;

type UploadFinalizeBody = {
  uploadId: string;
};

type AuxiliaryHttpAuthorizer = (params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  daemonRequest: Pick<DaemonRequest, 'command' | 'positionals'>;
  /** The upload ingress signal: authorization stops at the same deadline or disconnect. */
  signal: AbortSignal;
}) => Promise<{ tenantId?: string } | null>;

export function tryHandleUploadHttpRoute(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  authorize: AuxiliaryHttpAuthorizer;
  token: string;
  origin: string;
}): boolean {
  const { req, res, authorize, token, origin } = params;
  const route = resolveUploadHttpRoute(req);
  if (route === null) return false;

  void handleUploadHttpRoute(route, req, res, authorize, token, origin);
  return true;
}

async function handleUploadHttpRoute(
  route: UploadHttpRoute,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorize: AuxiliaryHttpAuthorizer,
  token: string,
  origin: string,
): Promise<void> {
  switch (route.kind) {
    case 'preflight':
      await handleUploadPreflight(req, res, authorize, token, origin);
      return;
    case 'direct':
      await handleResumableUpload(route.uploadId, req, res, authorize);
      return;
    case 'finalize':
      await handleUploadFinalize(req, res, authorize);
      return;
    case 'upload':
      await handleUpload(req, res, authorize);
      return;
  }
}

function resolveUploadHttpRoute(req: http.IncomingMessage): UploadHttpRoute | null {
  const pathname = req.url?.split('?')[0];
  if (req.method === 'POST' && pathname === '/upload/preflight') return { kind: 'preflight' };
  if (req.method === 'PUT' && req.url?.startsWith(DIRECT_UPLOAD_PATH_PREFIX)) {
    return {
      kind: 'direct',
      uploadId: req.url.slice(DIRECT_UPLOAD_PATH_PREFIX.length).replace(/\?.*$/, ''),
    };
  }
  if (req.method === 'POST' && pathname === '/upload/finalize') return { kind: 'finalize' };
  if (req.method === 'POST' && pathname === '/upload') return { kind: 'upload' };
  return null;
}

/**
 * Runs one upload route under its ingress owner (#4441): finite budgets admitted at the
 * callback (a 600-second aggregate plus a 120-second body-inactivity ceiling), the
 * authorization under the same signal, one failure answer, and one release.
 */
async function runUploadRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorize: AuxiliaryHttpAuthorizer,
  positionals: string[],
  handle: (auth: { tenantId?: string }, ingress: UploadTransferIngress) => Promise<void>,
): Promise<void> {
  const ingress = beginUploadTransferIngress({ req, res });
  try {
    const auth = await authorizeUpload(authorize, req, res, ingress.signal, positionals);
    if (!auth) return;
    await handle(auth, ingress);
  } catch (error) {
    answerUploadFailure(res, error);
  } finally {
    ingress.dispose();
  }
}

/** The upload command and positionals the auth hook sees, under the ingress signal. */
async function authorizeUpload(
  authorize: AuxiliaryHttpAuthorizer,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  signal: AbortSignal,
  positionals: string[],
): Promise<{ tenantId?: string } | null> {
  return await authorize({
    req,
    res,
    signal,
    daemonRequest: { command: 'upload', positionals },
  });
}

async function handleUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorize: AuxiliaryHttpAuthorizer,
): Promise<void> {
  await runUploadRoute(req, res, authorize, [], async (auth, ingress) => {
    sendUploadedArtifactResponse(
      res,
      await receiveUpload(req, {
        signal: ingress.signal,
        onBodyBytes: (bytes) => ingress.onAcceptedBodyBytes(bytes),
        onBodyComplete: () => ingress.bodyComplete(),
      }),
      auth.tenantId,
      () => ingress.ensureActive(),
    );
  });
}

async function handleUploadPreflight(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorize: AuxiliaryHttpAuthorizer,
  token: string,
  origin: string,
): Promise<void> {
  await runUploadRoute(req, res, authorize, ['preflight'], async (auth, ingress) => {
    const body = await readRestJsonBody(req, 64 * 1024, ingress.onAcceptedBodyBytes);
    // The JSON body is fully received: inactivity stops here and the remaining work
    // observes only the aggregate (#4441).
    ingress.bodyComplete();
    const preflight = readUploadPreflightBody(body);
    // No ticket is created once a deadline has passed.
    ingress.ensureActive();
    const upload = beginResumableUpload({
      baseUrl: origin,
      tokenHeaders: buildUploadTicketAuthHeaders(token),
      ...preflight,
      tenantId: auth.tenantId,
    });
    sendJson(res, { ok: true, ...upload });
  });
}

async function handleResumableUpload(
  uploadId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorize: AuxiliaryHttpAuthorizer,
): Promise<void> {
  await runUploadRoute(req, res, authorize, ['direct', uploadId], async (auth, ingress) => {
    const result = await receiveResumableUploadChunk({
      uploadId,
      req,
      tenantId: auth.tenantId,
      signal: ingress.signal,
      ensureActive: () => ingress.ensureActive(),
      onAcceptedBytes: (bytes) => ingress.onAcceptedBodyBytes(bytes),
      onBodyComplete: () => ingress.bodyComplete(),
    });
    if (result.complete) {
      res.statusCode = 200;
      res.end('ok');
      return;
    }

    res.statusCode = 308;
    if (result.offset > 0) {
      res.setHeader('range', `bytes=0-${result.offset - 1}`);
    }
    res.setHeader('x-upload-offset', String(result.offset));
    res.end();
  });
}

async function handleUploadFinalize(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorize: AuxiliaryHttpAuthorizer,
): Promise<void> {
  await runUploadRoute(req, res, authorize, ['finalize'], async (auth, ingress) => {
    const body = await readRestJsonBody(req, 64 * 1024, ingress.onAcceptedBodyBytes);
    // The JSON body is fully received: inactivity stops here, so the post-body hash,
    // extraction and registration observe only the aggregate (#4441).
    ingress.bodyComplete();
    const finalize = readUploadFinalizeBody(body);
    sendUploadedArtifactResponse(
      res,
      // The request's ingress signal is threaded through the serialized admission into
      // the post-body hash, the owned extraction stream and artifact materialization.
      await finalizeResumableUpload(finalize.uploadId, auth.tenantId, {
        signal: ingress.signal,
        ensureActive: () => ingress.ensureActive(),
      }),
      auth.tenantId,
      () => ingress.ensureActive(),
    );
  });
}

function sendJson(res: http.ServerResponse, body: Record<string, unknown>): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * Registers a finished artifact and answers. A deadline that passed before registration
 * removes the unregistered directory and answers with the same typed expiry as the timer.
 */
function sendUploadedArtifactResponse(
  res: http.ServerResponse,
  result: { artifactPath: string; tempDir: string },
  tenantId: string | undefined,
  ensureActive: () => void,
): void {
  try {
    ensureActive();
  } catch (error) {
    fs.rmSync(result.tempDir, { recursive: true, force: true });
    throw error;
  }
  const uploadId = trackUploadedArtifact({
    artifactPath: result.artifactPath,
    tempDir: result.tempDir,
    tenantId,
  });
  sendJson(res, { ok: true, uploadId });
}

/** Answers a route failure unless the ingress already ended the exchange with its expiry. */
function answerUploadFailure(res: http.ServerResponse, error: unknown): void {
  if (res.headersSent) return;
  sendRestJsonError(res, normalizeError(error));
}

async function readRestJsonBody(
  req: http.IncomingMessage,
  maxBodyBytes: number,
  onAcceptedBytes: (bytes: number) => void,
): Promise<Record<string, unknown>> {
  const raw = (
    await readNodeHttpRequestBody(req, maxBodyBytes, 'Request body is too large.', onAcceptedBytes)
  ).toString('utf8');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new AppError('INVALID_ARGS', 'Invalid JSON request body', {}, error);
  }
}

function readUploadPreflightBody(record: Record<string, unknown>): UploadPreflightBody {
  return {
    sha256: readRequiredText(record, 'sha256'),
    uploadAttemptId: readRequiredText(record, 'uploadAttemptId'),
    fileName: readRequiredText(record, 'fileName'),
    sizeBytes: readRequiredInteger(record, 'sizeBytes'),
    artifactType: readRequiredArtifactType(record),
    platform: readOptionalText(record, 'platform'),
    contentType: readOptionalText(record, 'contentType'),
  };
}

function readUploadFinalizeBody(record: Record<string, unknown>): UploadFinalizeBody {
  return {
    uploadId: readRequiredText(record, 'uploadId'),
  };
}

function readRequiredText(record: Record<string, unknown>, key: string): string {
  const value = readOptionalText(record, key)?.trim();
  if (!value) throw new AppError('INVALID_ARGS', `${key} is required`);
  return value;
}

function readOptionalText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readRequiredInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new AppError('INVALID_ARGS', `${key} must be an integer`);
  }
  return value;
}

function readRequiredArtifactType(record: Record<string, unknown>): 'file' | 'app-bundle' {
  const value = readRequiredText(record, 'artifactType');
  if (value === 'file' || value === 'app-bundle') return value;
  throw new AppError('INVALID_ARGS', 'artifactType must be "file" or "app-bundle"');
}

function buildUploadTicketAuthHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'x-agent-device-token': token,
  };
}
