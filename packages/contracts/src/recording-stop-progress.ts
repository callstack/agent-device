import type { NativePathDisposition } from './recording-native-path.ts';
import type { StopObservation } from './recording-stop-observation.ts';

/**
 * What a stop learned before it could commit (ADR 0024 2.3). These are the manifest's checkpoints:
 * each names a durable artifact the next attempt may reuse, so a retry never re-runs work that would
 * change the video. They are written under the fence as the stop produces them, and a stop that
 * fails leaves them with the manifest `open`.
 *
 * `collectedPath` is the immutable copy `collect` produced from the recorder's native path; the
 * export is never written into that path and the copy is never finalized in place. `finalization`
 * carries what the finalizer returned, so a commit failure — not a media failure — can be retried
 * without applying the touch overlay a second time.
 */
export type RecordingStopProgress = Readonly<{
  observation?: StopObservation;
  collectedPath?: string;
  exportPath?: string;
  /** What the recorder's exit says about the video, kept so a retry discloses it again. */
  recorderWarning?: string;
  finalization?: Readonly<{
    telemetryPath?: string;
    warning?: string;
    overlayWarning?: string;
    nativePathDisposition?: NativePathDisposition;
  }>;
}>;

/** Whether a retry has to ask the recorder to stop again (ADR 0024 2.3, step 1). */
export function mustSignalRecorder(progress: RecordingStopProgress): boolean {
  if (progress.exportPath !== undefined) return false;
  return progress.observation === undefined || progress.observation.recorder === 'unconfirmed';
}
