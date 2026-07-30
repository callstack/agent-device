import type { DaemonArtifact } from '@agent-device/kernel/contracts';
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

/**
 * The daemon-owned recording-backend discriminant (issue #974). A PLATFORM-NEUTRAL
 * string tag naming which recording backend a device resolves to; the daemon maps it
 * back to the concrete {@link RecordingBackend} instance via `RECORDING_BACKENDS_BY_TAG`.
 * The {@link PlatformPlugin.recording} facet returns this tag (type-only in the plugin,
 * exactly like {@link LogBackend} for app-log), so core/platforms never construct the
 * daemon-owned backend objects. `'unsupported'` is the fallthrough for families that
 * carry no recording facet (linux) and any unregistered platform.
 */
export type RecordingBackendTag =
  | 'web'
  | 'android'
  | 'macos'
  | 'ios-device'
  | 'ios-simulator'
  | 'unsupported';
