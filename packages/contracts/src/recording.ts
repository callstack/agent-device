import type { DaemonArtifact } from '@agent-device/kernel/contracts';
import type { RecorderObservation } from './recording-stop-observation.ts';
import type { NativePathDisposition } from './recording-native-path.ts';
import type { RecordingScope } from './recording-scope.ts';

export type RecordingAppIdentity = {
  bundleId: string;
  name?: string;
};

export type RecordingStartCommandResult = {
  recording: 'started';
  outPath: string;
  sessionStateDir: string;
  recordingBackend?: string;
  recordingScope?: RecordingScope;
  recordOnlySession?: boolean;
  activeSessionApp?: RecordingAppIdentity;
  showTouches: boolean;
};

export type RecordingStopCommandResult = {
  recording: 'stopped';
  outPath: string;
  telemetryPath?: string;
  artifacts: DaemonArtifact[];
  recordingBackend?: string;
  recordingScope?: RecordingScope;
  recordOnlySession?: boolean;
  activeSessionApp?: RecordingAppIdentity;
  durationMs: number;
  capturedDurationMs?: number;
  /**
   * What the recorder itself was observed doing when the stop was carried out (ADR 0024 2.2).
   * `confirmed` is the ordinary answer; `unconfirmed` and `lost` say the export was served without
   * proof that the recorder terminated, which is a disclosure and not a failure. Absent on a
   * response replayed from a manifest written before this field existed.
   */
  recorder?: RecorderObservation;
  /**
   * What the recorder's native artifact path was left as (ADR 0024 2.3): `retired` once the backend
   * removed it and verified that, `retirable` when the writer is proven gone and a fenced removal is
   * still owed, `pending` when nothing proves the writer gone yet. Absent when the backend has no
   * native path of its own to keep.
   */
  nativePathDisposition?: NativePathDisposition;
  showTouches: boolean;
  warning?: string;
  overlayWarning?: string;
  chunks?: Array<{
    index: number;
    path: string;
  }>;
};

export type RecordingCommandResult = RecordingStartCommandResult | RecordingStopCommandResult;

export type TraceCommandResult =
  | {
      trace: 'started';
      outPath: string;
    }
  | {
      trace: 'stopped';
      outPath: string;
      artifacts: DaemonArtifact[];
    };
