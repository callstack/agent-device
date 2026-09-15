import type { DurableCaptureProgress } from '@agent-device/contracts/durable-resource';
import {
  mustSignalRecorder,
  type ScreenRecordingFinalization,
} from '@agent-device/contracts/recording-stop-progress';
import type { StopObservation } from '@agent-device/contracts/recording-stop-observation';
import type {
  ScreenRecordingCompletion,
  ScreenRecordingLiveSnapshot,
} from '@agent-device/contracts/screen-recording-runtime';
import { createScreenRecordingCompletion } from '../screen-recording-completion.ts';
import { collectedRecordingPath } from './artifact-paths.ts';
import { readStopCheckpoints, writeStopCheckpoint } from './stop-checkpoints.ts';

/** Where a recorder writes when its file must stay separate from the export (ADR 0024 2.3). */
export { collectedRecordingPath, nativeRecordingPath } from './artifact-paths.ts';

/** What a backend learned while asking its recorder to stop (ADR 0024 2.2). */
export type RecorderStop = Readonly<{
  observation: StopObservation;
  warning?: string;
}>;

/**
 * The four things a backend can do to a recording, named separately so a stop can commit between
 * them (ADR 0024 2.3). A backend implements these and owns nothing about ordering: the sequence below
 * decides when a recorder is asked again, when a collected copy may be reused, and which facts are
 * durable before the export is written.
 */
export type ScreenRecordingStopSteps = Readonly<{
  /** Signal this recording's recorder safely and report what was observed. Writes no artifacts. */
  stop(): Promise<RecorderStop>;
  /** Copy or pull the recorder's own artifact into `collectedPath`, past the container sniff. */
  collect(collectedPath: string): Promise<void>;
  /**
   * Turn the collected copy into the export. Never finalizes the recorder's own path in place, and
   * reports what became of that path once the export is durable. `stoppedAtMs` is the instant the
   * recorder was signalled, journaled with that signal, so a resumed stop measures the same window.
   */
  finalize(
    input: Readonly<{ collectedPath: string; exportPath: string; stoppedAtMs: number }>,
  ): Promise<ScreenRecordingFinalization>;
  /** Remove the collected copy. It runs only once the finalization is journaled, and never throws. */
  discard(collectedPath: string): Promise<void>;
}>;

/**
 * One `record stop`, driven to a committed export (ADR 0024 2.3).
 *
 * Each step writes its checkpoint before the next begins, so an attempt that dies mid-stop leaves the
 * manifest holding exactly what is true: a recorder that was signalled and never confirmed is asked
 * again, a collected copy is collected once, and an export that was already finalized is never overlaid
 * a second time.
 */
export async function stopAndExportScreenRecording(
  params: Readonly<{
    steps: ScreenRecordingStopSteps;
    snapshot: ScreenRecordingLiveSnapshot;
    progress?: DurableCaptureProgress;
    now?: () => number;
  }>,
): Promise<Readonly<{ status: 'completed'; result: ScreenRecordingCompletion }>> {
  const { steps, snapshot, progress, now = Date.now } = params;
  const learned = readStopCheckpoints(progress?.learned);
  let observation = learned.observation;
  let recorderWarning = learned.recorderWarning;
  let stoppedAtMs = learned.stoppedAtMs;
  if (mustSignalRecorder(learned)) {
    // Read before the signal: everything after it is this tool's own export latency, not capture.
    stoppedAtMs = now();
    const stop = await steps.stop();
    observation = stop.observation;
    recorderWarning = stop.warning;
    progress?.record(
      writeStopCheckpoint({ observation, stoppedAtMs, recorderWarning: stop.warning }),
    );
  }
  if (observation === undefined) {
    throw new Error(
      'record stop reached collection without an observation of its recorder and a committed export',
    );
  }
  const collectedPath = learned.collectedPath ?? collectedRecordingPath(snapshot.outPath);
  if (learned.collectedPath === undefined) {
    await steps.collect(collectedPath);
    progress?.record(writeStopCheckpoint({ collectedPath }));
  }
  const finalization =
    learned.finalization ??
    (await steps.finalize({
      collectedPath,
      exportPath: snapshot.outPath,
      stoppedAtMs: stoppedAtMs ?? now(),
    }));
  progress?.record(writeStopCheckpoint({ exportPath: snapshot.outPath, finalization }));
  // The copy is what a retry re-finalizes from, so it goes only after the finalization it produced is
  // journaled: from here a retry replays that finalization and never reads the copy again.
  await steps.discard(collectedPath);
  const { nativePathDisposition, warning, ...exportFacts } = finalization;
  const warnings = [warning, recorderWarning].filter(
    (entry): entry is string => entry !== undefined && entry.length > 0,
  );
  // The recorder's disclosure is folded into the warning the caller reads; every other field the
  // finalizer returned is served as it was journaled, so a replay serves what the first stop would have.
  return createScreenRecordingCompletion(
    snapshot,
    { ...exportFacts, ...(warnings.length === 0 ? {} : { warning: warnings.join(' ') }) },
    {
      stopObservation: observation,
      ...(nativePathDisposition === undefined ? {} : { nativePathDisposition }),
    },
  );
}
