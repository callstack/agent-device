import type http from 'node:http';
import { normalizeError } from '../kernel/errors.ts';

export type NormalizedHttpError = ReturnType<typeof normalizeError>;

export function statusCodeForNormalizedError(code: string): number {
  switch (code) {
    case 'INVALID_ARGS':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'SESSION_NOT_FOUND':
    // ADR 0012 R7 (C5a): a reaped repair session is a gone-session state, like
    // SESSION_NOT_FOUND — not an internal error.
    case 'REPAIR_SESSION_EXPIRED':
      return 404;
    default:
      return 500;
  }
}

export function sendRestJsonError(res: http.ServerResponse, normalized: NormalizedHttpError): void {
  res.statusCode = statusCodeForNormalizedError(normalized.code);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: normalized.message, code: normalized.code }));
}
