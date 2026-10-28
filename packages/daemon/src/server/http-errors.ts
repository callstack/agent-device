import type http from 'node:http';
import { normalizeError } from '@agent-device/kernel/errors';

export type NormalizedHttpError = ReturnType<typeof normalizeError>;

export function statusCodeForNormalizedError(error: {
  code: string;
  details?: Record<string, unknown>;
}): number {
  switch (error.code) {
    case 'INVALID_ARGS':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'SESSION_NOT_FOUND':
    // ADR 0012 R7 (C5a): a reaped repair session is a gone-session state, like
    // SESSION_NOT_FOUND — not an internal error.
    // fallthrough
    case 'REPAIR_SESSION_EXPIRED':
      return 404;
    case 'DEVICE_IN_USE':
      return error.details?.reason === 'human_control_active' ? 423 : 500;
    case 'COMMAND_FAILED':
      // A TTL registry cannot tell an expired id from one that never existed,
      // so a gone resource is 404 rather than 410.
      return error.details?.reason === 'RESOURCE_EXPIRED' ? 404 : 500;
    default:
      return 500;
  }
}

export function sendRestJsonError(res: http.ServerResponse, normalized: NormalizedHttpError): void {
  res.statusCode = statusCodeForNormalizedError(normalized);
  res.setHeader('content-type', 'application/json');
  const reason = normalized.details?.reason;
  res.end(
    JSON.stringify({
      ok: false,
      error: normalized.message,
      code: normalized.code,
      ...(typeof reason === 'string' ? { reason } : {}),
      ...(normalized.hint !== undefined ? { hint: normalized.hint } : {}),
    }),
  );
}

/**
 * A file stream that fails mid-download: still an error status when nothing has
 * been written, but once headers are out the only honest signal left is
 * destroying the connection, so the client sees a truncated body rather than a
 * complete one.
 */
export function failStreamedHttpResponse(res: http.ServerResponse, error: Error): void {
  if (res.headersSent) {
    res.destroy(error);
    return;
  }
  const normalized = normalizeError(error);
  res.statusCode = statusCodeForNormalizedError(normalized);
  res.end(normalized.message);
}
