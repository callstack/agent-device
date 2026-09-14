import type { DurableCaptureProgress } from '@agent-device/contracts/durable-resource';
import { mustSignalRecorder } from '@agent-device/contracts/recording-stop-progress';
import type { StopObservation } from '@agent-device/contracts/recording-stop-observation';
import type {
  ScreenRecordingCompletion,
  ScreenRecordingLiveSnapshot,
} from '@agent-device/contracts/screen-recording-runtime';
import { createScreenRecordingCompletion } from '../screen-recording-completion.ts';
import { collectedRecordingPath } from './artifact-paths.ts';
import { readStopCheckpoints, writeStopCheckpoint } from './stop-checkpoints.ts';
import type { NativePathDisposition } from '@agent-device/contracts/recording-native-path';

/** What a backend learned while asking its recorder to stop (ADR 0024 2.2). */
export type RecorderStop = Readonly<{
  observation: StopObservation;
  warning?: string;
}>;

/** What finalization produced: the export's own facts, and what became of the recorder's path. */
export type ScreenRecordingFinalization = Readonly<{
  telemetryPath?: string;
  warning?: string;
  overlayWarning?: string;
  nativePathDisposition?: NativePathDisposition;
}>;

/**
 * The three things a backend can do to a recording, named separately so a stop can commit between
 * them (ADR 0024 2.3). A backend implements these and owns nothing about ordering: the sequence below
 * decides when a recorder is asked again, when a collected copy may be reused, and which facts are
 * durable before the export is written.
 */
export type ScreenRecordingStopSteps = Readonly<{
  /** Signal this recording's recorder safely and report what was observed. Writes no artifacts. */
  stop(): Promise<RecorderStop>;
  /** Copy or pull the recorder's own artifact into `collectedPath`, past the playability sniff. */
  collect(collectedPath: string): Promise<void>;
  /**
   * Turn the collected copy into the export. Never finalizes the recorder's own path in place, and
   * reports what became of that path once the export is durable.
   */
  finalize(
    input: Readonly<{ collectedPath: string; exportPath: string }>,
  ): Promise<ScreenRecordingFinalization>;
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
  }>,
): Promise<Readonly<{ status: 'completed'; result: ScreenRecordingCompletion }>> {
  const { steps, snapshot, progress } = params;
  const learned = readStopCheckpoints(progress?.learned);
  let observation = learned.observation;
  let recorderWarning = learned.recorderWarning;
  if (mustSignalRecorder(learned)) {
    const stop = await steps.stop();
    observation = stop.observation;
    recorderWarning = stop.warning;
    progress?.record(writeStopCheckpoint({ observation, recorderWarning: stop.warning }));
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
    learned.finalization ?? (await steps.finalize({ collectedPath, exportPath: snapshot.outPath }));
  progress?.record(writeStopCheckpoint({ exportPath: snapshot.outPath, finalization }));
  return createScreenRecordingCompletion(snapshot, joinWarnings(finalization, recorderWarning), {
    stopObservation: observation,
    ...(finalization.nativePathDisposition === undefined
      ? {}
      : { nativePathDisposition: finalization.nativePathDisposition }),
  });
}

function joinWarnings(
  finalization: ScreenRecordingFinalization,
  recorderWarning: string | undefined,
): Readonly<{ telemetryPath?: string; warning?: string; overlayWarning?: string }> {
  const warnings = [finalization.warning, recorderWarning].filter(
    (warning): warning is string => warning !== undefined && warning.length > 0,
  );
  return {
    ...(finalization.telemetryPath === undefined
      ? {}
      : { telemetryPath: finalization.telemetryPath }),
    ...(finalization.overlayWarning === undefined
      ? {}
      : { overlayWarning: finalization.overlayWarning }),
    ...(warnings.length === 0 ? {} : { warning: warnings.join(' ') }),
  };
}
