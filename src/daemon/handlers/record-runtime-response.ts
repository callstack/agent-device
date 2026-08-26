import path from 'node:path';
import type { RecordingCommandResult } from '@agent-device/contracts/recording';
import type {
  ScreenRecordingCompletion,
  ScreenRecordingLiveSnapshot,
} from '@agent-device/contracts/screen-recording-runtime';
import type { RuntimeOperationUnavailability } from '@agent-device/contracts/platform-runtime';
import type { DaemonArtifact, DaemonResponse } from '../types.ts';
import { deriveRecordingTelemetryPath } from '../../recording/telemetry.ts';

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
  return {
    ok: true,
    data: {
      recording: 'stopped',
      outPath: completion.outPath,
      telemetryPath: completion.telemetryPath,
      artifacts,
      recordingBackend: completion.backend,
      recordingScope: completion.scope,
      recordOnlySession: completion.recordOnlySession,
      activeSessionApp: completion.activeSessionApp,
      durationMs: Math.max(0, completion.completedAt - completion.startedAt),
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

function recordingArtifact(completion: ScreenRecordingCompletion): DaemonArtifact {
  return {
    field: 'outPath',
    artifactType: 'screen-recording',
    path: completion.outPath,
    localPath: completion.clientOutPath,
    fileName: path.basename(completion.clientOutPath ?? completion.outPath),
  };
}
