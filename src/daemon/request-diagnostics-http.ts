/**
 * `GET /sessions/<session>/requests/<requestId>/diagnostics` — the one request's
 * diagnostics record, streamed as ndjson (#1801).
 *
 * A failed command names its diagnostics record by path, and that path is on the
 * DAEMON host. A remote caller — a CI runner driving an EAS/limrun simulator —
 * cannot read that filesystem, so the record has to be reachable over the same
 * base URL and token the caller already holds. The client side is
 * `src/remote/remote-request-diagnostics.ts`.
 *
 * Scope: exactly one record, addressed the way the error names it
 * (`DaemonError.diagnosticsRecord`). A record that was never written (the
 * request never reached a session scope, or the daemon has since been reset)
 * answers 404 — the route deliberately does not enumerate what exists.
 */

import fs from 'node:fs';
import http from 'node:http';
import { AppError, normalizeError, type DiagnosticsRecordRef } from '@agent-device/kernel/errors';
import type { DaemonRequest } from './types.ts';
import { isSafeSessionSegment } from './session-paths.ts';
import { decodeUriSegment } from './http-request-target.ts';
import { isTenantOwnedSessionName } from './session-tenant-scope.ts';
import { failStreamedHttpResponse, sendRestJsonError } from './http-errors.ts';

const REQUEST_DIAGNOSTICS_CONTENT_TYPE = 'application/x-ndjson';

/**
 * `/sessions/<session>/requests/<requestId>/diagnostics` as data: the literal
 * segments a request must match, with `null` where the caller supplies a name.
 * The leading `''` is the empty segment before the first slash.
 */
const REQUEST_DIAGNOSTICS_ROUTE_SHAPE = [
  '',
  'sessions',
  null,
  'requests',
  null,
  'diagnostics',
] as const;
const SESSION_SEGMENT_INDEX = 2;
const REQUEST_ID_SEGMENT_INDEX = 4;

type RequestDiagnosticsHttpAuthorizer = (params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  daemonRequest: Pick<DaemonRequest, 'command' | 'positionals'>;
}) => Promise<{ tenantId?: string } | null>;

export type RequestDiagnosticsHttpOptions = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  authorize: RequestDiagnosticsHttpAuthorizer;
  /**
   * Where the daemon keeps the record for `ref`. Supplied by the runtime that
   * owns the session store, so this module never builds a session artifact path
   * of its own (AGENTS.md, "Session artifact paths come from session-store").
   */
  resolveRecordPath: (ref: DiagnosticsRecordRef) => string;
};

export function tryHandleRequestDiagnosticsHttpRoute(
  options: RequestDiagnosticsHttpOptions,
): boolean {
  const ref = resolveRequestDiagnosticsHttpRoute(options.req);
  if (ref === null) return false;
  void handleRequestDiagnostics(ref, options);
  return true;
}

/**
 * The record locator this request addresses, or `null` when the request is not
 * for this route at all. A malformed locator inside the route's own shape
 * resolves to a ref that `handleRequestDiagnostics` rejects, so an unusable
 * name answers 400 rather than falling through to the RPC dispatcher's 404.
 */
function resolveRequestDiagnosticsHttpRoute(
  req: http.IncomingMessage,
): DiagnosticsRecordRef | null {
  if (req.method !== 'GET') return null;
  const segments = (req.url ?? '').split('?', 1)[0]!.split('/');
  if (segments.length !== REQUEST_DIAGNOSTICS_ROUTE_SHAPE.length) return null;
  const shapeMatches = REQUEST_DIAGNOSTICS_ROUTE_SHAPE.every(
    (literal, index) => literal === null || segments[index] === literal,
  );
  if (!shapeMatches) return null;
  return {
    session: decodeUriSegment(segments[SESSION_SEGMENT_INDEX] ?? ''),
    requestId: decodeUriSegment(segments[REQUEST_ID_SEGMENT_INDEX] ?? ''),
  };
}

async function handleRequestDiagnostics(
  ref: DiagnosticsRecordRef,
  options: RequestDiagnosticsHttpOptions,
): Promise<void> {
  const { req, res, authorize, resolveRecordPath } = options;
  try {
    if (!isSafeSessionSegment(ref.session) || !isSafeSessionSegment(ref.requestId)) {
      sendRestJsonError(
        res,
        normalizeError(
          new AppError('INVALID_ARGS', 'Invalid session or request id in diagnostics route'),
        ),
      );
      return;
    }

    const auth = await authorize({
      req,
      res,
      daemonRequest: {
        command: 'request_diagnostics',
        positionals: [ref.session, ref.requestId],
      },
    });
    if (!auth) return;

    if (auth.tenantId && !isTenantOwnedSessionName(auth.tenantId, ref.session)) {
      sendRestJsonError(
        res,
        normalizeError(
          new AppError('UNAUTHORIZED', 'Session is outside this tenant', {
            session: ref.session,
          }),
        ),
      );
      return;
    }

    const recordPath = resolveRecordPath(ref);
    const stats = await statRecord(recordPath);
    if (!stats) {
      sendRestJsonError(
        res,
        normalizeError(
          new AppError(
            'SESSION_NOT_FOUND',
            `No diagnostics record for request ${ref.requestId} in session ${ref.session}`,
            {
              hint: 'The daemon keeps a request record only for the session it ran in; re-run the command against this daemon to produce a fresh one.',
            },
          ),
        ),
      );
      return;
    }

    const stream = fs.createReadStream(recordPath);
    res.statusCode = 200;
    res.setHeader('content-type', REQUEST_DIAGNOSTICS_CONTENT_TYPE);
    res.setHeader('content-length', String(stats.size));
    stream.on('error', (error) => {
      failStreamedHttpResponse(res, error);
    });
    stream.pipe(res);
  } catch (error) {
    sendRestJsonError(res, normalizeError(error));
  }
}

async function statRecord(recordPath: string): Promise<fs.Stats | null> {
  try {
    const stats = await fs.promises.stat(recordPath);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}
