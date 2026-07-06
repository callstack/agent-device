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
  startNextChunk: (
    preferredRemoteDir: string,
    nextIndex: number,
  ) => Promise<AndroidScreenrecordChunk>;
  finishCurrentChunk: (chunk: AndroidScreenrecordChunk) => Promise<string | undefined>;
  cleanupStartedChunk?: (chunk: AndroidScreenrecordChunk) => Promise<void>;
  persistRecordingState?: (recording: AndroidRecording) => Promise<void>;
}): void {
  const {
    recording,
    startNextChunk,
    finishCurrentChunk,
    cleanupStartedChunk,
    persistRecordingState,
  } = params;
  const timer = setTimeout(() => {
    recording.rotationPromise = rotateAndroidRecordingChunk({
      recording,
      startNextChunk,
      finishCurrentChunk,
      cleanupStartedChunk,
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
            cleanupStartedChunk,
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
  startNextChunk: (
    preferredRemoteDir: string,
    nextIndex: number,
  ) => Promise<AndroidScreenrecordChunk>;
  finishCurrentChunk: (chunk: AndroidScreenrecordChunk) => Promise<string | undefined>;
  cleanupStartedChunk?: (chunk: AndroidScreenrecordChunk) => Promise<void>;
  persistRecordingState?: (recording: AndroidRecording) => Promise<void>;
}): Promise<void> {
  const {
    recording,
    startNextChunk,
    finishCurrentChunk,
    cleanupStartedChunk,
    persistRecordingState,
  } = params;
  if (recording.stopping) return;

  const chunks = ensureAndroidRecordingChunks(recording);
  const nextIndex = chunks.length + 1;
  const previousChunk = {
    remotePath: recording.remotePath,
    remotePid: recording.remotePid,
    startedAt: recording.remoteStartedAt ?? recording.startedAt,
  };
  const started = await startNextAndroidRecordingChunkWithFallback({
    recording,
    nextIndex,
    previousChunk,
    startNextChunk,
    finishCurrentChunk,
  });
  if (!started) return;
  const { nextChunk, previousChunkFinished } = started;
  const previousState = applyNextAndroidRecordingChunk({
    recording,
    nextChunk,
  });
  await commitNextAndroidRecordingChunk({
    recording,
    chunks,
    nextChunk,
    nextIndex,
    previousState,
    finishCurrentChunk,
    cleanupStartedChunk,
    persistRecordingState,
  });
  if (previousChunkFinished) {
    return;
  }
  await finishAndroidRecordingChunkOrThrow(finishCurrentChunk, previousChunk);
}

async function startNextAndroidRecordingChunkWithFallback(params: {
  recording: AndroidRecording;
  nextIndex: number;
  previousChunk: AndroidScreenrecordChunk;
  startNextChunk: (
    preferredRemoteDir: string,
    nextIndex: number,
  ) => Promise<AndroidScreenrecordChunk>;
  finishCurrentChunk: (chunk: AndroidScreenrecordChunk) => Promise<string | undefined>;
}): Promise<{ nextChunk: AndroidScreenrecordChunk; previousChunkFinished: boolean } | undefined> {
  const { recording, nextIndex, previousChunk, startNextChunk, finishCurrentChunk } = params;
  const preferredRemoteDir = path.posix.dirname(recording.remotePath);
  try {
    return {
      nextChunk: await startNextChunk(preferredRemoteDir, nextIndex),
      previousChunkFinished: false,
    };
  } catch (concurrentStartError) {
    const stopError = await finishCurrentChunk(previousChunk);
    if (stopError) {
      throw new Error(stopError);
    }
    if (recording.stopping) return undefined;
    try {
      return {
        nextChunk: await startNextChunk(preferredRemoteDir, nextIndex),
        previousChunkFinished: true,
      };
    } catch (sequentialStartError) {
      throw sequentialStartError instanceof Error ? sequentialStartError : concurrentStartError;
    }
  }
}

function applyNextAndroidRecordingChunk(params: {
  recording: AndroidRecording;
  nextChunk: AndroidScreenrecordChunk;
}): Pick<AndroidRecording, 'remotePath' | 'remotePid' | 'remoteStartedAt'> {
  const { recording, nextChunk } = params;
  const previousState = {
    remotePath: recording.remotePath,
    remotePid: recording.remotePid,
    remoteStartedAt: recording.remoteStartedAt,
  };
  recording.remotePath = nextChunk.remotePath;
  recording.remotePid = nextChunk.remotePid;
  recording.remoteStartedAt = nextChunk.startedAt;
  return previousState;
}

async function commitNextAndroidRecordingChunk(params: {
  recording: AndroidRecording;
  chunks: NonNullable<AndroidRecording['chunks']>;
  nextChunk: AndroidScreenrecordChunk;
  nextIndex: number;
  previousState: Pick<AndroidRecording, 'remotePath' | 'remotePid' | 'remoteStartedAt'>;
  finishCurrentChunk: (chunk: AndroidScreenrecordChunk) => Promise<string | undefined>;
  cleanupStartedChunk?: (chunk: AndroidScreenrecordChunk) => Promise<void>;
  persistRecordingState?: (recording: AndroidRecording) => Promise<void>;
}): Promise<void> {
  const {
    recording,
    chunks,
    nextChunk,
    nextIndex,
    previousState,
    finishCurrentChunk,
    cleanupStartedChunk,
    persistRecordingState,
  } = params;
  chunks.push({
    index: nextIndex,
    path: deriveAndroidChunkOutPath(recording.outPath, nextIndex),
    remotePath: nextChunk.remotePath,
  });
  recording.warning ??=
    'Android adb screenrecord is capped at 180s, so this recording was split into multiple MP4 chunks.';
  try {
    await persistRecordingState?.(recording);
  } catch (error) {
    rollbackNextAndroidRecordingChunk({ recording, chunks, previousState });
    const cleanupError = await discardNextAndroidRecordingChunk({
      nextChunk,
      finishCurrentChunk,
      cleanupStartedChunk,
    });
    if (cleanupError) throw cleanupError;
    throw error;
  }
}

function rollbackNextAndroidRecordingChunk(params: {
  recording: AndroidRecording;
  chunks: NonNullable<AndroidRecording['chunks']>;
  previousState: Pick<AndroidRecording, 'remotePath' | 'remotePid' | 'remoteStartedAt'>;
}): void {
  const { recording, chunks, previousState } = params;
  chunks.pop();
  recording.remotePath = previousState.remotePath;
  recording.remotePid = previousState.remotePid;
  recording.remoteStartedAt = previousState.remoteStartedAt;
}

async function finishAndroidRecordingChunkOrThrow(
  finishCurrentChunk: (chunk: AndroidScreenrecordChunk) => Promise<string | undefined>,
  chunk: AndroidScreenrecordChunk,
): Promise<void> {
  const stopError = await finishCurrentChunk(chunk);
  if (stopError) {
    throw new Error(stopError);
  }
}

async function discardNextAndroidRecordingChunk(params: {
  nextChunk: AndroidScreenrecordChunk;
  finishCurrentChunk: (chunk: AndroidScreenrecordChunk) => Promise<string | undefined>;
  cleanupStartedChunk?: (chunk: AndroidScreenrecordChunk) => Promise<void>;
}): Promise<unknown | undefined> {
  const { nextChunk, finishCurrentChunk, cleanupStartedChunk } = params;
  let discardError: unknown;
  try {
    await finishAndroidRecordingChunkOrThrow(finishCurrentChunk, nextChunk);
  } catch (error) {
    discardError = error;
  }
  try {
    await cleanupStartedChunk?.(nextChunk);
  } catch (error) {
    discardError ??= error;
  }
  return discardError;
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
