import path from 'node:path';
import { AppError, normalizeError, toAppErrorCode } from '../kernel/errors.ts';
import {
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
} from '../utils/diagnostics.ts';
import type { DaemonArtifact, DaemonRequest, DaemonResponse, DaemonResponseData } from './types.ts';

export function finalizeDaemonResponse(
  req: DaemonRequest,
  response: DaemonResponse,
  trackArtifact: (opts: { artifactPath: string; tenantId?: string; fileName?: string }) => string,
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
  trackArtifact: (opts: { artifactPath: string; tenantId?: string; fileName?: string }) => string,
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
        artifactId: trackArtifact({
          artifactPath,
          tenantId: req.meta?.tenantId,
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
