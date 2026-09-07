import path from 'node:path';
import type { DiagnosticsRecordRef } from '@agent-device/kernel/errors';
import { safeSessionName } from './session-paths.ts';

/** Path to session-scoped platform subprocess output, such as Apple runner xcodebuild logs. */
export function resolveSessionRunnerLogPath(sessionDir: string): string {
  return path.join(sessionDir, 'runner.log');
}

/** Path to request-scoped daemon diagnostics for this session. */
export function resolveSessionRequestLogPath(
  sessionDir: string,
  requestId: string | undefined,
): string {
  const safeRequestId = safeSessionName(requestId && requestId.length > 0 ? requestId : 'unknown');
  return path.join(sessionDir, 'requests', `${safeRequestId}.ndjson`);
}

/**
 * The request diagnostics record for one request: the path it is written to on
 * this host, and the locator a remote caller fetches the same record by
 * (#1801). Built in one call so the two can never name different records.
 */
export function resolveSessionRequestLog(params: {
  sessionDir: string;
  session: string;
  requestId: string | undefined;
}): { path: string; ref: DiagnosticsRecordRef } {
  return {
    path: resolveSessionRequestLogPath(params.sessionDir, params.requestId),
    ref: {
      session: params.session,
      requestId: params.requestId && params.requestId.length > 0 ? params.requestId : 'unknown',
    },
  };
}

/**
 * Where a CLIENT keeps its own copy of a remote daemon's request diagnostics
 * record (#1801). Mirrors the daemon-side layout under the caller's state dir
 * so a CI job can archive `remote-diagnostics/` wholesale.
 */
export function resolveRemoteRequestDiagnosticsPath(
  stateDir: string,
  ref: DiagnosticsRecordRef,
): string {
  return resolveSessionRequestLogPath(
    path.join(stateDir, 'remote-diagnostics', safeSessionName(ref.session)),
    ref.requestId,
  );
}
