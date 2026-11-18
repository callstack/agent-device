import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import path from 'node:path';
import type { RecordingCommandResult } from '@agent-device/contracts/recording';
import type {
  ScreenRecordingCompletion,
  ScreenRecordingLiveSnapshot,
} from '@agent-device/contracts/screen-recording-runtime';
import type { RuntimeOperationUnavailability } from '@agent-device/contracts/platform-runtime';
import { deriveRecordingTelemetryPath } from '@agent-device/capture-kit/recording-telemetry';
import { isRemoteTempArtifactPath } from '@agent-device/contracts/daemon-http';

export function isDaemonOwnedRecordingOutput(
  completion: ScreenRecordingCompletion,
  remoteCaptureOutput: boolean,
): boolean {
  return (
    remoteCaptureOutput ||
    (completion.clientOutPath !== undefined &&
      isRemoteTempArtifactPath(completion.outPath, 'recording', path.extname(completion.outPath)))
  );
}

export function buildRecordingStartResponse(
  snapshot: ScreenRecordingLiveSnapshot,
  sessionStateDir: string,
  requestedOutPath: string,
): DaemonResponse {
  return {
    ok: true,
    data: {
      recording: 'started',
      outPath: snapshot.clientOutPath ?? requestedOutPath,
      sessionStateDir,
      recordingBackend: snapshot.backend,
      recordingScope: snapshot.scope,
      recordOnlySession: snapshot.recordOnlySession,
      activeSessionApp: snapshot.activeSessionApp,
      showTouches: snapshot.showTouches,
    } satisfies RecordingCommandResult,
  };
}

export function buildRecordingStartedAction(snapshot: ScreenRecordingLiveSnapshot) {
  return {
    action: 'start',
    ...(snapshot.clientOutPath ? { requestedFileName: path.basename(snapshot.clientOutPath) } : {}),
    showTouches: snapshot.showTouches,
  };
}

export function buildRecordingUnsupportedResponse(
  fact: RuntimeOperationUnavailability,
): DaemonResponse {
  return {
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: 'record is not supported on this device',
      hint:
        fact.hint ??
        'Select an Apple, Android, physical HarmonyOS, or web target that supports screen recording.',
      details: { reason: fact.reason },
    },
  };
}

export function buildRecordingStopResponse(completion: ScreenRecordingCompletion): DaemonResponse {
  return {
    ok: true,
    data: {
      recording: 'stopped',
      outPath: completion.outPath,
      telemetryPath: completion.telemetryPath,
      artifacts: recordingStopArtifacts(completion),
      recordingBackend: completion.backend,
      recordingScope: completion.scope,
      recordOnlySession: completion.recordOnlySession,
      activeSessionApp: completion.activeSessionApp,
      durationMs: Math.max(0, completion.completedAt - completion.startedAt),
      ...(completion.capturedDurationMs === undefined
        ? {}
        : { capturedDurationMs: completion.capturedDurationMs }),
      // Only the word the recorder observation answers with goes on the wire; its reason stays in the
      // manifest, where recovery and diagnostics read it.
      ...(completion.stopObservation === undefined
        ? {}
        : { recorder: completion.stopObservation.recorder }),
      ...(completion.nativePathDisposition === undefined
        ? {}
        : { nativePathDisposition: completion.nativePathDisposition }),
      showTouches: completion.showTouches,
      warning: completion.warning,
      overlayWarning: completion.overlayWarning,
      chunks: completion.chunks?.map((chunk) => ({
        index: chunk.index,
        path: chunk.clientOutPath ?? chunk.path,
      })),
    } satisfies RecordingCommandResult,
  };
}

/**
 * #4518: echoes the capture grant ID the daemon bound to the accepted capture, so the client can
 * match this stop to the grant IT minted and persisted before dispatch. The ID is echoed from the
 * capture's own durable record; the internal ownership fence never leaves the envelope.
 */
export function withCaptureGrantEcho(
  response: DaemonResponse,
  grantId: string | undefined,
): DaemonResponse {
  if (grantId === undefined || !response.ok || !response.data) return response;
  const artifacts = Array.isArray(response.data.artifacts) ? response.data.artifacts : [];
  return {
    ...response,
    data: {
      ...response.data,
      captureGrantId: grantId,
      artifacts: artifacts.map((artifact) => ({ ...artifact, captureGrantId: grantId })),
    },
  };
}

/** The files a finished recording hands to its caller: the video, later chunks, and telemetry. */
export function recordingStopArtifacts(completion: ScreenRecordingCompletion): DaemonArtifact[] {
  const artifacts: DaemonArtifact[] = [recordingArtifact(completion)];
  if (completion.chunks && completion.chunks.length > 1) {
    artifacts.push(
      ...completion.chunks.slice(1).map((chunk) => ({
        field: 'chunkPath',
        artifactType: 'screen-recording-chunk' as const,
        path: chunk.path,
        localPath: chunk.clientOutPath,
        fileName: path.basename(chunk.clientOutPath ?? chunk.path),
      })),
    );
  }
  if (completion.telemetryPath) {
    const clientTelemetryPath = completion.clientOutPath
      ? deriveRecordingTelemetryPath(completion.clientOutPath)
      : undefined;
    artifacts.push({
      field: 'telemetryPath',
      artifactType: 'screen-recording-telemetry',
      path: completion.telemetryPath,
      localPath: clientTelemetryPath,
      fileName: path.basename(completion.telemetryPath),
    });
  }
  return artifacts;
}

function recordingArtifact(completion: ScreenRecordingCompletion): DaemonArtifact {
  return {
    field: 'outPath',
    artifactType: 'screen-recording',
    path: completion.outPath,
    localPath: completion.clientOutPath,
    fileName: path.basename(completion.clientOutPath ?? completion.outPath),
  };
}
