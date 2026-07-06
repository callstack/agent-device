import path from 'node:path';
import type { SessionState } from '../types.ts';
import type { RecordTraceDeps } from './record-trace-types.ts';
import { finalizeRecordingOverlay } from './record-trace-finalize.ts';
import { persistRecordingTelemetry } from '../recording-telemetry.ts';

const ANDROID_SCREENRECORD_TIME_LIMIT_MS = 180_000;
const ANDROID_SCREENRECORD_TIME_LIMIT_GRACE_MS = 2_000;
const ANDROID_SCREENRECORD_CHUNK_MS = 170_000;

type AndroidRecording = Extract<NonNullable<SessionState['recording']>, { platform: 'android' }>;

type AndroidScreenrecordChunk = {
  remotePath: string;
  remotePid: string;
  startedAt: number;
};

export function deriveAndroidChunkOutPath(outPath: string, chunkIndex: number): string {
  if (chunkIndex === 1) {
    return outPath;
  }
  const parsed = path.parse(outPath);
  const extension = parsed.ext || '.mp4';
  return path.join(
    parsed.dir,
    `${parsed.name}.part-${String(chunkIndex).padStart(3, '0')}${extension}`,
  );
}

export function ensureAndroidRecordingChunks(
  recording: AndroidRecording,
): NonNullable<AndroidRecording['chunks']> {
  recording.chunks ??= [
    {
      index: 1,
      path: recording.outPath,
      remotePath: recording.remotePath,
    },
  ];
  return recording.chunks;
}

export function resolveAndroidScreenrecordLimitWarning(
  recording: AndroidRecording,
): string | undefined {
  const elapsedMs = Date.now() - recording.startedAt;
  if (elapsedMs < ANDROID_SCREENRECORD_TIME_LIMIT_MS - ANDROID_SCREENRECORD_TIME_LIMIT_GRACE_MS) {
    return undefined;
  }
  return 'Android adb screenrecord stopped before record stop, likely after reaching the 180s platform limit. The MP4 may be truncated; final interactions after the limit are not in the video.';
}

export function scheduleAndroidRecordingRotation(params: {
  recording: AndroidRecording;
  startNextChunk: (preferredRemoteDir: string) => Promise<AndroidScreenrecordChunk>;
  finishCurrentChunk: () => Promise<string | undefined>;
  persistRecordingState?: (recording: AndroidRecording) => Promise<void>;
}): void {
  const { recording, startNextChunk, finishCurrentChunk, persistRecordingState } = params;
  const timer = setTimeout(() => {
    recording.rotationPromise = rotateAndroidRecordingChunk({
      recording,
      startNextChunk,
      finishCurrentChunk,
      persistRecordingState,
    })
      .catch((error: unknown) => {
        recording.rotationFailedReason = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        recording.rotationPromise = undefined;
        if (!recording.stopping && !recording.rotationFailedReason) {
          scheduleAndroidRecordingRotation({
            recording,
            startNextChunk,
            finishCurrentChunk,
            persistRecordingState,
          });
        }
      });
  }, ANDROID_SCREENRECORD_CHUNK_MS);
  timer.unref?.();
  recording.rotationTimer = timer;
}

async function rotateAndroidRecordingChunk(params: {
  recording: AndroidRecording;
  startNextChunk: (preferredRemoteDir: string) => Promise<AndroidScreenrecordChunk>;
  finishCurrentChunk: () => Promise<string | undefined>;
  persistRecordingState?: (recording: AndroidRecording) => Promise<void>;
}): Promise<void> {
  const { recording, startNextChunk, finishCurrentChunk, persistRecordingState } = params;
  if (recording.stopping) return;
  const stopError = await finishCurrentChunk();
  if (stopError) {
    throw new Error(stopError);
  }
  if (recording.stopping) return;

  const chunks = ensureAndroidRecordingChunks(recording);
  const nextIndex = chunks.length + 1;
  const nextChunk = await startNextChunk(path.posix.dirname(recording.remotePath));
  recording.remotePath = nextChunk.remotePath;
  recording.remotePid = nextChunk.remotePid;
  recording.remoteStartedAt = nextChunk.startedAt;
  chunks.push({
    index: nextIndex,
    path: deriveAndroidChunkOutPath(recording.outPath, nextIndex),
    remotePath: nextChunk.remotePath,
  });
  recording.warning ??=
    'Android adb screenrecord is capped at 180s, so this recording was split into multiple MP4 chunks.';
  await persistRecordingState?.(recording);
}

export async function finalizeAndroidRecordingOutput(params: {
  recording: AndroidRecording;
  deps: RecordTraceDeps;
}): Promise<void> {
  const { recording, deps } = params;
  const chunks = ensureAndroidRecordingChunks(recording);
  if (chunks.length <= 1) {
    await finalizeRecordingOverlay({
      recording,
      deps,
      targetLabel: 'Android recording',
    });
    return;
  }

  persistRecordingTelemetry({ recording });
  if (recording.showTouches && recording.gestureEvents.length > 0) {
    recording.overlayWarning ??=
      'touch overlay burn-in is skipped for chunked Android recordings; returning raw chunks plus gesture telemetry';
  }
}
