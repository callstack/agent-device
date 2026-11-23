import path from 'node:path';
import { isRecord } from '@agent-device/kernel/record';
import {
  AppError,
  normalizeError,
  retriableForErrorCode,
  toAppErrorCode,
  type DaemonError,
} from '@agent-device/kernel/errors';
import { normalizeTenantId } from '@agent-device/contracts/daemon-http';
import { resolveSessionRequestLog } from '@agent-device/daemon-contracts/session-artifact-paths';
import {
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
  updateDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type { SessionStore } from '../core/session-store.ts';
import { scopeRequestSession } from '../sessions/request-admission.ts';
import { resolveEffectiveSessionName } from '../sessions/session-routing.ts';
import { sessionIdleExpiredError } from './session-idle-expiry.ts';
import type { IdleSessionTombstone } from '../core/session-idle-tombstone.ts';
import type {
  DaemonArtifact,
  DaemonResponse,
  DaemonResponseData,
} from '@agent-device/kernel/contracts';
import { isDeviceRotation, type DeviceRotation } from '@agent-device/contracts/device';
import {
  claimRequestDiagnosticsRecord,
  leaseVerifier,
  requestDiagnosticsRecordId,
  type TrackDownloadableArtifact,
} from '../resources/artifact-tracking.ts';
import { tenantScopedSessionName } from '../core/session-tenant-scope.ts';
import {
  captureOutputLeaseVerifier,
  captureOutputOwnership,
  captureOutputTenantId,
  daemonDeliveredArtifact,
} from '../core/capture-output-ownership.ts';

/** A response artifact plus the capture facts the inventory reports beside it. */
type PendingArtifact = DaemonArtifact & {
  displayRotation?: DeviceRotation;
  deleteAfterDownload?: boolean;
};

export function installDetachedRequestDiagnostics(
  req: DaemonRequest,
  store: Pick<SessionStore, 'resolveSessionDir'>,
): void {
  claimRequestDiagnosticsRecord(req);
  const tenant = normalizeTenantId(
    typeof req.meta?.tenantId === 'string' ? req.meta.tenantId : req.flags?.tenant,
  );
  const namespace = 'request-diagnostics';
  const session = tenant ? tenantScopedSessionName(tenant, namespace) : namespace;
  const record = resolveSessionRequestLog({
    session,
    sessionDir: store.resolveSessionDir(session),
    requestId: requestDiagnosticsRecordId(req),
    directory: 'request-records',
  });
  updateDiagnosticsScope({ logPath: record.path, logRecord: record.ref });
}

export function finalizeThrownRequestError(error: unknown): DaemonResponse {
  emitDiagnostic({
    level: 'error',
    phase: 'request_failed',
    data: { error: error instanceof Error ? error.message : String(error) },
  });
  const details = getDiagnosticsMeta();
  const record = flushDiagnosticsToSessionFile({ force: true });
  return {
    ok: false,
    error: normalizeError(error, {
      diagnosticId: details.diagnosticId,
      logPath: record?.path,
      diagnosticsRecord: record?.ref,
    }),
  };
}

export function finalizeDaemonResponse(
  req: DaemonRequest,
  response: DaemonResponse,
  trackArtifact: TrackDownloadableArtifact,
): DaemonResponse {
  const details = getDiagnosticsMeta();
  if (!response.ok) {
    emitDiagnostic({
      level: 'error',
      phase: 'request_failed',
      data: {
        code: response.error.code,
        message: response.error.message,
      },
    });
    const flushed = flushDiagnosticsToSessionFile({ force: true });
    // ADR 0012 decision 6, BLOCKER 2 (second follow-up): every handler-RETURNED
    // (as opposed to thrown) failure response is rebuilt here into a fresh
    // AppError before re-normalizing — this used to copy `hint`/`diagnosticId`/
    // `logPath` from the incoming `response.error` but NOT `retriable`/
    // `supportedOn`, so a handler that set them at the correct top-level
    // location (matching `DaemonError`'s wire contract) still lost them at
    // this reconstruction, regardless of how correctly the handler itself
    // built its response. Both are now carried through the same way, with the
    // same defensive `details` fallback `hint` already used (some cause
    // objects still carry them nested under `details` instead of top-level).
    const normalizedError = normalizeError(
      new AppError(toAppErrorCode(response.error.code), response.error.message, {
        ...(response.error.details ?? {}),
        hint:
          response.error.hint ??
          (typeof response.error.details?.hint === 'string'
            ? response.error.details.hint
            : undefined),
        diagnosticId: response.error.diagnosticId,
        logPath: response.error.logPath,
        diagnosticsRecord: response.error.diagnosticsRecord,
        retriable:
          response.error.retriable ??
          (typeof response.error.details?.retriable === 'boolean'
            ? response.error.details.retriable
            : undefined),
        supportedOn:
          response.error.supportedOn ??
          (typeof response.error.details?.supportedOn === 'string'
            ? response.error.details.supportedOn
            : undefined),
      }),
      {
        diagnosticId: details.diagnosticId,
        logPath: flushed?.path,
        diagnosticsRecord: flushed?.ref,
      },
    );
    return { ok: false, error: normalizedError };
  }
  emitDiagnostic({ level: 'info', phase: 'request_success' });
  flushDiagnosticsToSessionFile();
  return {
    ok: true,
    data: registerDownloadableArtifacts(req, response.data, trackArtifact),
  };
}

function registerDownloadableArtifacts(
  req: DaemonRequest,
  data: DaemonResponseData | undefined,
  trackArtifact: TrackDownloadableArtifact,
): DaemonResponseData | undefined {
  if (!data) return data;
  const admittedLeaseId = req.internal?.admittedLease?.leaseId;
  const producer = captureOutputLeaseVerifier(data);
  const admittedOwner = admittedLeaseId && leaseVerifier(admittedLeaseId);
  const tenantId = captureOutputTenantId(data) ?? req.meta?.tenantId;
  const register = (artifact: PendingArtifact): DaemonArtifact => {
    const artifactPath = artifact.path as string;
    const delivered = daemonDeliveredArtifact(artifact);
    const owner = delivered || producer === undefined ? admittedOwner : producer;
    return {
      field: artifact.field,
      // Omitted (not null/undefined-valued) when untyped, matching the
      // optional wire contract on DaemonArtifact.
      ...(artifact.artifactType !== undefined ? { artifactType: artifact.artifactType } : {}),
      artifactId: trackArtifact({
        artifactPath,
        tenantId: delivered ? delivered.tenantId : tenantId,
        ...(owner ? { leaseVerifier: owner } : {}),
        artifactType: artifact.artifactType,
        fileName: artifact.fileName,
        ...(artifact.deleteAfterDownload === false ? { deleteAfterDownload: false } : {}),
        ...(isDeviceRotation(artifact.displayRotation)
          ? { displayRotation: artifact.displayRotation }
          : {}),
      }),
      fileName: artifact.fileName,
      localPath: artifact.localPath,
      scriptPublicationId: artifact.scriptPublicationId,
      scriptRevision: artifact.scriptRevision,
    };
  };
  if (captureOutputOwnership(data) === 'caller') {
    // Caller-owned capture output stays at the caller path; a daemon-delivered artifact still registers.
    if (!data.artifacts?.some(daemonDeliveredArtifact)) return data;
    return {
      ...data,
      artifacts: data.artifacts.map((item) =>
        daemonDeliveredArtifact(item) ? register(item) : item,
      ),
    };
  }
  const pendingArtifacts = collectPendingArtifacts(req, data);
  if (pendingArtifacts.length === 0) return data;
  const committed = Array.isArray(data.artifacts)
    ? data.artifacts.filter((artifact) => artifact?.artifactId && !artifact.path)
    : [];
  return { ...data, artifacts: [...committed, ...pendingArtifacts.map(register)] };
}

function collectPendingArtifacts(req: DaemonRequest, data: DaemonResponseData): PendingArtifact[] {
  const ownership = captureOutputOwnership(data);
  const artifacts: PendingArtifact[] = Array.isArray(data.artifacts) ? [...data.artifacts] : [];
  const hasField = (field: string): boolean =>
    artifacts.some((artifact) => artifact?.field === field);
  if (!hasField('outPath')) {
    const performance = pendingPerformanceArtifact(req, data);
    if (performance) artifacts.push(performance);
  }
  return artifacts.filter((artifact): artifact is PendingArtifact =>
    Boolean(
      artifact &&
      typeof artifact.field === 'string' &&
      typeof artifact.path === 'string' &&
      (ownership === 'daemon' ||
        daemonDeliveredArtifact(artifact) !== undefined ||
        (req.internal?.publicNetworkOnly && !['record', 'perf', 'trace'].includes(req.command)) ||
        (typeof artifact.localPath === 'string' && artifact.localPath.length > 0) ||
        (artifact.field === 'fallbackScreenshotPath' && artifact.artifactType === 'screenshot')),
    ),
  );
}

function pendingPerformanceArtifact(
  req: DaemonRequest,
  data: DaemonResponseData,
): PendingArtifact | undefined {
  if (captureOutputOwnership(data) !== 'daemon' || req.command !== 'perf') return undefined;
  const capture = isRecord(data.artifact) ? data.artifact : undefined;
  const artifactPath =
    typeof capture?.path === 'string' ? capture.path : performanceResponseOutputPath(req, data);
  if (typeof artifactPath !== 'string') return undefined;
  return {
    field: 'outPath',
    artifactType: 'performance',
    path: artifactPath,
    localPath:
      req.meta?.clientArtifactPaths?.outPath ??
      (typeof data.clientOutPath === 'string' ? data.clientOutPath : undefined),
    fileName: path.basename(artifactPath),
    ...(req.positionals?.[0]?.toLowerCase() === 'cpu' &&
    req.positionals?.[2]?.toLowerCase() === 'stop'
      ? { deleteAfterDownload: false }
      : {}),
  };
}

function performanceResponseOutputPath(req: DaemonRequest, data: DaemonResponseData): unknown {
  const [area, operation, action] = (req.positionals ?? []).map((value) => value.toLowerCase());
  if (action === 'report' || action === 'stop') return data.outPath;
  if (area === 'trace' && operation === 'stop') return data.outPath;
  return undefined;
}

/**
 * ADR 0012 decision 6, R7 (C5a, BLOCKER 2): when a request finds no session
 * (SESSION_NOT_FOUND) but a live repair tombstone exists for its session key,
 * rewrite the error to an actionable recovery error. Any other error, or the
 * absence of a (non-expired) tombstone, passes through untouched.
 *
 * BLOCKER 2: a tombstone carrying `commitFailure` means the transaction
 * actually COMPLETED and a commit was attempted at teardown but FAILED (e.g.
 * no-clobber refusal, a filesystem error) — that is a materially different,
 * more specific situation than "reaped before it ever finished", so it gets
 * its own `REPAIR_COMMIT_FAILED` code carrying the real cause, rather than
 * being folded into the generic `REPAIR_SESSION_EXPIRED` expiry message.
 */
export function repairExpiredIfTombstoned(
  req: DaemonRequest,
  error: DaemonError,
  sessionStore: SessionStore,
): DaemonError {
  if (error.code !== 'SESSION_NOT_FOUND') return error;
  const address = resolveTombstoneSessionAddress(req, sessionStore);
  if (address === undefined) return error;
  const tombstone = sessionStore.readRepairTombstone(address);
  if (!tombstone) return error;
  const reRun = tombstone.sourcePath
    ? `re-run: replay ${tombstone.sourcePath} --save-script`
    : 're-run your replay <script> --save-script from the start';
  if (tombstone.commitFailure) {
    return normalizeError(
      new AppError(
        'REPAIR_COMMIT_FAILED',
        `The repair transaction for session "${req.session}" completed, but committing its healed script failed at teardown: ${tombstone.commitFailure.message}. ${reRun}.`,
      ),
    );
  }
  return normalizeError(
    new AppError(
      'REPAIR_SESSION_EXPIRED',
      `The --save-script repair session "${req.session}" was reaped before it was finalized (idle-reap); ${reRun}.`,
    ),
  );
}

/**
 * #2833: when a command finds no session because this daemon already expired it for idleness, the
 * answer stays `SESSION_NOT_FOUND` — the session genuinely is gone — but carries the typed reason,
 * the window it missed, and the device it released. A bare "Run open first" tells an agent on a
 * shared machine to retry an `open` that will collide with its own expired session's claim if the
 * release is still in flight, and gives it nothing to reason about either way.
 *
 * Consulted after the repair tombstone so an abandoned repair transaction keeps its own, more
 * specific recovery guidance. The address is resolved through the same routing the request took; a
 * name that cannot be resolved has no marker rather than an error that would replace the caller's.
 */
export function idleExpiredIfTombstoned(
  req: DaemonRequest,
  error: DaemonError,
  sessionStore: SessionStore,
): DaemonError {
  if (error.code !== 'SESSION_NOT_FOUND') return error;
  const tombstone = readIdleExpiryTombstoneSafely(req, sessionStore);
  if (!tombstone) return error;
  return normalizeError(sessionIdleExpiredError(tombstone.owner, tombstone));
}

function resolveTombstoneSessionAddress(
  req: DaemonRequest,
  sessionStore: SessionStore,
): string | undefined {
  try {
    return resolveEffectiveSessionName(scopeRequestSession(req), sessionStore, {
      attachesToSession: false,
    });
  } catch {
    return undefined;
  }
}

function readIdleExpiryTombstoneSafely(
  req: DaemonRequest,
  sessionStore: SessionStore,
): IdleSessionTombstone | undefined {
  const address = resolveTombstoneSessionAddress(req, sessionStore);
  if (address === undefined) return undefined;
  try {
    return sessionStore.readIdleExpiryTombstone(address);
  } catch {
    return undefined;
  }
}

// Phase 2 typed-error graft: add machine-readable signals to an error response.
// Returns the error unchanged unless a signal applies, so the default wire shape
// is preserved for the common codes.
export function enrichDaemonError(error: DaemonError): DaemonError {
  // A throw-site classification (lifted from details by normalizeError) wins
  // over the conservative code-level policy.
  const retriable = error.retriable ?? retriableForErrorCode(error.code);
  if (retriable === undefined) return error;
  return {
    ...error,
    retriable,
  };
}
