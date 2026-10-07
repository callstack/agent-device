import type { IncomingHttpHeaders } from 'node:http';
import { DAEMON_HTTP_PRINCIPAL_HEADER } from '@agent-device/contracts/daemon-http';
import { AppError } from '@agent-device/kernel/errors';
import { normalizeTenantId } from '../config.ts';

/**
 * The principal the Host front-end sent on the daemon-token loopback request (ADR 0021 §6).
 * `null` when the header is present but malformed, so the caller refuses it instead of ignoring it.
 */
export function readHostPrincipal(headers: IncomingHttpHeaders): string | undefined | null {
  const raw = headers[DAEMON_HTTP_PRINCIPAL_HEADER];
  if (raw === undefined) return undefined;
  return (typeof raw === 'string' ? normalizeTenantId(raw) : undefined) ?? null;
}

export function hostPrincipalInvalidError(): AppError {
  return new AppError('INVALID_ARGS', 'Invalid params: the Host principal header is malformed', {
    reason: 'host-principal-invalid',
    hint: 'A Host principal uses the tenant format: 1-128 letters, digits, dot, underscore or dash.',
  });
}
