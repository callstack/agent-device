import path from 'node:path';
import { AppError, normalizeError, toAppErrorCode } from '../kernel/errors.ts';
import {
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
} from '../utils/diagnostics.ts';
import type { DaemonRequest, DaemonResponse, DaemonResponseData } from './types.ts';
import type { DaemonArtifact, DaemonArtifactType } from '../kernel/contracts.ts';

export function finalizeDaemonResponse(
  req: DaemonRequest,
  response: DaemonResponse,
  trackArtifact: (opts: {
    artifactPath: string;
    tenantId?: string;
    artifactType: DaemonArtifactType | undefined;
    fileName?: string;
  }) => string,
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
    const logPathOnFailure = flushDiagnosticsToSessionFile({ force: true }) ?? undefined;
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
        logPath: logPathOnFailure,
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
  trackArtifact: (opts: {
    artifactPath: string;
    tenantId?: string;
    artifactType: DaemonArtifactType | undefined;
    fileName?: string;
  }) => string,
): DaemonResponseData | undefined {
  if (!data) return data;
  const pendingArtifacts = collectPendingArtifacts(req, data);
  if (pendingArtifacts.length === 0) return data;
  return {
    ...data,
    artifacts: pendingArtifacts.map((artifact) => {
      const artifactPath = artifact.path as string;
      return {
        field: artifact.field,
        // Omitted (not null/undefined-valued) when untyped, matching the
        // optional wire contract on DaemonArtifact.
        ...(artifact.artifactType !== undefined ? { artifactType: artifact.artifactType } : {}),
        artifactId: trackArtifact({
          artifactPath,
          tenantId: req.meta?.tenantId,
          artifactType: artifact.artifactType,
          fileName: artifact.fileName,
        }),
        fileName: artifact.fileName,
        localPath: artifact.localPath,
      };
    }),
  };
}

function collectPendingArtifacts(req: DaemonRequest, data: DaemonResponseData): DaemonArtifact[] {
  const artifacts = Array.isArray(data.artifacts) ? [...data.artifacts] : [];
  const hasField = (field: string): boolean =>
    artifacts.some((artifact) => artifact?.field === field);
  if (req.command === 'screenshot' && !hasField('path') && typeof data.path === 'string') {
    artifacts.push({
      field: 'path',
      artifactType: 'screenshot',
      path: data.path,
      localPath: req.meta?.clientArtifactPaths?.path,
      fileName: path.basename(req.meta?.clientArtifactPaths?.path ?? data.path),
    });
  }
  return artifacts.filter((artifact): artifact is DaemonArtifact =>
    Boolean(
      artifact &&
      typeof artifact.field === 'string' &&
      typeof artifact.path === 'string' &&
      typeof artifact.localPath === 'string' &&
      artifact.localPath.length > 0,
    ),
  );
}
