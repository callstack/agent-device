import type { NativePathDisposition } from './recording-native-path.ts';
import type { StopObservation } from './recording-stop-observation.ts';
import type { ScreenRecordingChunk } from './screen-recording-runtime.ts';

/** What finalization produced: the export's own facts, and what became of the recorder's path. */
export type ScreenRecordingFinalization = Readonly<{
  telemetryPath?: string;
  warning?: string;
  overlayWarning?: string;
  nativePathDisposition?: NativePathDisposition;
  /** The files an export is served as when one recorder produced several of them. */
  chunks?: readonly ScreenRecordingChunk[];
  /** Wall time the recorder's own files cover, which is shorter than the stop's own export latency. */
  capturedDurationMs?: number;
}>;

/**
 * What a stop learned before it could commit (ADR 0024 2.3). These are the manifest's checkpoints:
 * each names a durable artifact the next attempt may reuse, so a retry never re-runs work that would
 * change the video. They are written under the fence as the stop produces them, and a stop that
 * fails leaves them with the manifest `open`.
 *
 * `collectedPath` is the immutable copy `collect` produced from the recorder's native path; the
 * export is never written into that path and the copy is never finalized in place. `finalization`
 * carries everything the finalizer returned, so a commit failure — not a media failure — can be
 * retried without applying the touch overlay a second time and without losing a served field.
 */
export type RecordingStopProgress = Readonly<{
  observation?: StopObservation;
  /** Host instant the recorder was signalled, so a resumed stop measures the same capture window. */
  stoppedAtMs?: number;
  collectedPath?: string;
  exportPath?: string;
  /** What the recorder's exit says about the video, kept so a retry discloses it again. */
  recorderWarning?: string;
  finalization?: ScreenRecordingFinalization;
}>;

/** Whether a retry has to ask the recorder to stop again (ADR 0024 2.3, step 1). */
export function mustSignalRecorder(progress: RecordingStopProgress): boolean {
  if (progress.exportPath !== undefined) return false;
  return progress.observation === undefined || progress.observation.recorder === 'unconfirmed';
}
