import type { DaemonArtifact } from '../kernel/contracts.ts';
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
    };
