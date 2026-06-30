import type { RecordingProvider } from '../recording-provider.ts';
import type { runCmd } from '../../utils/exec.ts';
import type { isPlayableVideo, waitForStableFile } from '../../utils/video.ts';
import type { runIosRunnerCommand } from '../../platforms/apple/core/runner/runner-client.ts';
import type {
  overlayRecordingTouches,
  resizeRecording,
  trimRecordingStart,
} from '../../recording/overlay.ts';
import type { RecordingGestureEvent } from '../types.ts';
import type { RecordingExportQuality } from '../../core/recording-export-quality.ts';

export type RecordTraceDeps = {
  runCmd: typeof runCmd;
  startIosSimulatorRecording: RecordingProvider['startIosSimulatorRecording'];
  runIosRunnerCommand: typeof runIosRunnerCommand;
  waitForRecordingTail: (
    recording: RecordingBase & { platform: 'ios' | 'android' },
  ) => Promise<void>;
  waitForStableFile: typeof waitForStableFile;
  isPlayableVideo: typeof isPlayableVideo;
  trimRecordingStart: typeof trimRecordingStart;
  resizeRecording: typeof resizeRecording;
  overlayRecordingTouches: typeof overlayRecordingTouches;
};

export type RecordingBase = {
  outPath: string;
  clientOutPath?: string;
  startedAt: number;
  maxSize?: number;
  exportQuality?: RecordingExportQuality;
  showTouches: boolean;
  gestureEvents: RecordingGestureEvent[];
};
