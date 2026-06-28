import http from 'node:http';
import { AppError, normalizeError } from '../utils/errors.ts';
import type { DaemonRequest } from './types.ts';
import { trackUploadedArtifact } from './artifact-tracking.ts';
import {
  beginResumableUpload,
  finalizeResumableUpload,
  receiveResumableUploadChunk,
} from './resumable-upload.ts';
import { receiveUpload } from './upload.ts';
import { sendRestJsonError } from './http-errors.ts';

type UploadHttpRoute = 'upload' | 'preflight' | 'direct' | 'finalize';

type AuxiliaryHttpAuthorizer = (params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  daemonRequest: Pick<DaemonRequest, 'command' | 'positionals'>;
}) => Promise<{ tenantId?: string } | null>;

export async function handleUploadHttpRoute(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  authorize: AuxiliaryHttpAuthorizer;
  token: string;
}): Promise<boolean> {
  const { req, res, authorize, token } = params;
  switch (resolveUploadHttpRoute(req)) {
    case 'preflight':
      await handleUploadPreflight(req, res, authorize, token);
      return true;
    case 'direct':
      await handleResumableUpload(req, res, authorize);
      return true;
    case 'finalize':
      await handleUploadFinalize(req, res, authorize);
      return true;
    case 'upload':
      await handleUpload(req, res, authorize);
      return true;
    default:
      return false;
  }
}

export function isUploadHttpRoute(req: http.IncomingMessage): boolean {
  return resolveUploadHttpRoute(req) !== null;
}

function resolveUploadHttpRoute(req: http.IncomingMessage): UploadHttpRoute | null {
  if (req.method === 'POST' && req.url === '/upload/preflight') return 'preflight';
  if (req.method === 'PUT' && req.url?.startsWith('/upload/direct/')) return 'direct';
  if (req.method === 'POST' && req.url === '/upload/finalize') return 'finalize';
  if (req.method === 'POST' && req.url === '/upload') return 'upload';
  return null;
}

async function handleUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorize: AuxiliaryHttpAuthorizer,
): Promise<void> {
  try {
    const auth = await authorize({
      req,
      res,
      daemonRequest: {
        command: 'upload',
        positionals: [],
      },
    });
    if (!auth) return;

    const result = await receiveUpload(req);
    const uploadId = trackUploadedArtifact({
      artifactPath: result.artifactPath,
      tempDir: result.tempDir,
      tenantId: auth.tenantId,
    });

    sendJson(res, { ok: true, uploadId });
  } catch (error) {
    sendRestJsonError(res, normalizeError(error));
  }
}

async function handleUploadPreflight(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorize: AuxiliaryHttpAuthorizer,
  token: string,
): Promise<void> {
  try {
    const auth = await authorize({
      req,
      res,
      daemonRequest: {
        command: 'upload',
        positionals: ['preflight'],
      },
    });
    if (!auth) return;

    const body = await readRestJsonBody(req, 64 * 1024);
    const upload = beginResumableUpload({
      baseUrl: resolveHttpRequestBaseUrl(req),
      tokenHeaders: buildUploadTicketAuthHeaders(token),
      sha256: readRequiredText(body, 'sha256'),
      fileName: readRequiredText(body, 'fileName'),
      sizeBytes: readRequiredInteger(body, 'sizeBytes'),
      artifactType: readRequiredArtifactType(body),
      platform: readOptionalText(body, 'platform'),
      contentType: readOptionalText(body, 'contentType'),
      tenantId: auth.tenantId,
    });

    sendJson(res, { ok: true, ...upload });
  } catch (error) {
    sendRestJsonError(res, normalizeError(error));
  }
}

async function handleResumableUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorize: AuxiliaryHttpAuthorizer,
): Promise<void> {
  const uploadId = req.url?.slice('/upload/direct/'.length).split('?')[0] ?? '';
  try {
    const auth = await authorize({
      req,
      res,
      daemonRequest: {
        command: 'upload',
        positionals: ['direct', uploadId],
      },
    });
    if (!auth) return;

    const result = await receiveResumableUploadChunk({ uploadId, req, tenantId: auth.tenantId });
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
  } catch (error) {
    sendRestJsonError(res, normalizeError(error));
  }
}

async function handleUploadFinalize(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorize: AuxiliaryHttpAuthorizer,
): Promise<void> {
  try {
    const auth = await authorize({
      req,
      res,
      daemonRequest: {
        command: 'upload',
        positionals: ['finalize'],
      },
    });
    if (!auth) return;

    const body = await readRestJsonBody(req, 64 * 1024);
    const result = await finalizeResumableUpload(readRequiredText(body, 'uploadId'), auth.tenantId);
    const uploadId = trackUploadedArtifact({
      artifactPath: result.artifactPath,
      tempDir: result.tempDir,
      tenantId: auth.tenantId,
    });

    sendJson(res, { ok: true, uploadId });
  } catch (error) {
    sendRestJsonError(res, normalizeError(error));
  }
}

function sendJson(res: http.ServerResponse, body: Record<string, unknown>): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readRestJsonBody(
  req: http.IncomingMessage,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodyBytes += buffer.length;
    if (bodyBytes > maxBodyBytes) {
      throw new AppError('INVALID_ARGS', 'Request body is too large.');
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
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

function resolveHttpRequestBaseUrl(req: http.IncomingMessage): string {
  const host = typeof req.headers.host === 'string' ? req.headers.host : '';
  if (!host) throw new AppError('INVALID_ARGS', 'Missing host header');
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return `${proto || 'http'}://${host}`;
}
