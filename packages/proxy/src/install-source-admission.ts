import type { ServerResponse } from 'node:http';
import { AppError, normalizeError } from '@agent-device/kernel/errors';

export function carriesUnbackedHostPathInstallSource(rpcBody: string | undefined): boolean {
  const params = readRpcParams(rpcBody);
  if (!params) return false;
  const meta = readRecord(params.meta);
  if (isBackedByUploadedArtifact(meta)) return false;
  return isHostPathInstallSource(params.source) || isHostPathInstallSource(meta?.installSource);
}

export function sendHostPathInstallSourceRefused(res: ServerResponse, rpcId: unknown): void {
  const error = new AppError(
    'INVALID_ARGS',
    'Invalid params: an install source of kind "path" names a file on the daemon host and is not accepted through the proxy',
    { hint: 'Upload the artifact, or use a "url" or "github-actions-artifact" source.' },
  );
  res.statusCode = 400;
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: -32602, message: error.message, data: normalizeError(error) },
    }),
  );
}

function readRpcParams(rpcBody: string | undefined): Record<string, unknown> | undefined {
  if (!rpcBody) return undefined;
  try {
    return readRecord(readRecord(JSON.parse(rpcBody))?.params);
  } catch {
    return undefined;
  }
}

function isBackedByUploadedArtifact(meta: Record<string, unknown> | undefined): boolean {
  const uploadedArtifactId = meta?.uploadedArtifactId;
  return typeof uploadedArtifactId === 'string' && uploadedArtifactId.trim().length > 0;
}

function isHostPathInstallSource(source: unknown): boolean {
  return readRecord(source)?.kind === 'path';
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
