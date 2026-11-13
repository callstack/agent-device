import path from 'node:path';
import { isRecord } from '@agent-device/kernel/record';
import { AppError, normalizeError, toAppErrorCode } from '@agent-device/kernel/errors';
import {
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
} from '@agent-device/host-kit/diagnostics';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type {
  DaemonArtifact,
  DaemonResponse,
  DaemonResponseData,
} from '@agent-device/kernel/contracts';
import { isDeviceRotation, type DeviceRotation } from '@agent-device/contracts/device';
import type { TrackDownloadableArtifact } from '../resources/artifact-tracking.ts';
import { captureOutputOwnership, captureOutputTenantId } from '../core/capture-output-ownership.ts';

/** A response artifact plus the capture facts the inventory reports beside it. */
type PendingArtifact = DaemonArtifact & {
  displayRotation?: DeviceRotation;
  deleteAfterDownload?: boolean;
};

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
          tenantId: captureOutputTenantId(data) ?? req.meta?.tenantId,
          artifactType: artifact.artifactType,
          fileName: artifact.fileName,
          ...(artifact.deleteAfterDownload === false ? { deleteAfterDownload: false } : {}),
          ...(isDeviceRotation(artifact.displayRotation)
            ? { displayRotation: artifact.displayRotation }
            : {}),
        }),
        fileName: artifact.fileName,
        localPath: artifact.localPath,
        ...(artifact.force !== undefined ? { force: artifact.force } : {}),
      };
    }),
  };
}

function collectPendingArtifacts(req: DaemonRequest, data: DaemonResponseData): PendingArtifact[] {
  const ownership = captureOutputOwnership(data);
  if (ownership === 'caller') return [];
  const artifacts: PendingArtifact[] = Array.isArray(data.artifacts) ? [...data.artifacts] : [];
  const hasField = (field: string): boolean =>
    artifacts.some((artifact) => artifact?.field === field);
  if (!hasField('path')) {
    const screenshot = pendingScreenshotArtifact(req, data);
    if (screenshot) artifacts.push(screenshot);
  }
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
        (req.internal?.publicNetworkOnly && !['record', 'perf', 'trace'].includes(req.command)) ||
        (typeof artifact.localPath === 'string' && artifact.localPath.length > 0) ||
        (artifact.field === 'fallbackScreenshotPath' && artifact.artifactType === 'screenshot')),
    ),
  );
}

function pendingScreenshotArtifact(
  req: DaemonRequest,
  data: DaemonResponseData,
): PendingArtifact | undefined {
  if (req.command !== 'screenshot' || typeof data.path !== 'string') return undefined;
  return {
    field: 'path',
    artifactType: 'screenshot',
    path: data.path,
    localPath: req.meta?.clientArtifactPaths?.path,
    fileName: path.basename(req.meta?.clientArtifactPaths?.path ?? data.path),
    ...(isDeviceRotation(data.displayRotation) ? { displayRotation: data.displayRotation } : {}),
  };
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
