import type { JsonObject } from '@agent-device/contracts/client';
import { isNativePathDisposition } from '@agent-device/contracts/recording-native-path';
import type { RecordingStopProgress } from '@agent-device/contracts/recording-stop-progress';
import {
  type StopObservation,
  isStopObservation,
} from '@agent-device/contracts/recording-stop-observation';

/**
 * How a stop's checkpoints are written into `screen-recording.resource.json`, and how much of them
 * the next attempt may trust (ADR 0024 2.3).
 *
 * The keys stay flat so each checkpoint merges into the metadata the previous one wrote instead of
 * replacing it. `read` is deliberately unforgiving: a checkpoint naming an artifact that was never
 * written is worse than no checkpoint, because resuming from it skips the step that would have
 * noticed. Anything this cannot vouch for comes back absent, so the next attempt redoes that step.
 */
const OBSERVATION_KEY = 'stopObservation';
const RECORDER_WARNING_KEY = 'stopRecorderWarning';
const COLLECTED_PATH_KEY = 'collectedPath';
const EXPORT_PATH_KEY = 'exportPath';
const FINALIZATION_KEY = 'stopFinalization';

export function writeStopCheckpoint(fact: Partial<RecordingStopProgress>): JsonObject {
  return {
    ...(fact.observation === undefined
      ? {}
      : { [OBSERVATION_KEY]: encodeObservation(fact.observation) }),
    ...(fact.recorderWarning === undefined ? {} : { [RECORDER_WARNING_KEY]: fact.recorderWarning }),
    ...(fact.collectedPath === undefined ? {} : { [COLLECTED_PATH_KEY]: fact.collectedPath }),
    ...(fact.exportPath === undefined ? {} : { [EXPORT_PATH_KEY]: fact.exportPath }),
    ...(fact.finalization === undefined
      ? {}
      : { [FINALIZATION_KEY]: encodeFinalization(fact.finalization) }),
  };
}

export function readStopCheckpoints(metadata: JsonObject | undefined): RecordingStopProgress {
  const observation = metadata?.[OBSERVATION_KEY];
  const recorderWarning = readNonEmptyString(metadata?.[RECORDER_WARNING_KEY]);
  const collectedPath = readNonEmptyString(metadata?.[COLLECTED_PATH_KEY]);
  const exportPath = readNonEmptyString(metadata?.[EXPORT_PATH_KEY]);
  const finalization = readFinalization(metadata?.[FINALIZATION_KEY]);
  return {
    ...(isStopObservation(observation) ? { observation } : {}),
    ...(recorderWarning === undefined ? {} : { recorderWarning }),
    ...(collectedPath === undefined ? {} : { collectedPath }),
    ...(exportPath === undefined ? {} : { exportPath }),
    ...(finalization === undefined ? {} : { finalization }),
  };
}

function encodeObservation(observation: StopObservation): JsonObject {
  return observation.recorder === 'confirmed'
    ? { recorder: observation.recorder }
    : { recorder: observation.recorder, why: observation.why };
}

function encodeFinalization(
  finalization: NonNullable<RecordingStopProgress['finalization']>,
): JsonObject {
  return {
    ...encodeOptionalString('telemetryPath', finalization.telemetryPath),
    ...encodeOptionalString('warning', finalization.warning),
    ...encodeOptionalString('overlayWarning', finalization.overlayWarning),
    ...(finalization.nativePathDisposition === undefined
      ? {}
      : { nativePathDisposition: finalization.nativePathDisposition }),
  };
}

function readFinalization(value: unknown): RecordingStopProgress['finalization'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate: {
    telemetryPath?: unknown;
    warning?: unknown;
    overlayWarning?: unknown;
    nativePathDisposition?: unknown;
  } = value;
  const disposition = candidate.nativePathDisposition;
  if (disposition !== undefined && !isNativePathDisposition(disposition)) return undefined;
  const telemetryPath = readNonEmptyString(candidate.telemetryPath);
  const warning = readNonEmptyString(candidate.warning);
  const overlayWarning = readNonEmptyString(candidate.overlayWarning);
  if (
    telemetryPath === undefined &&
    warning === undefined &&
    overlayWarning === undefined &&
    disposition === undefined
  ) {
    return undefined;
  }
  return {
    ...(telemetryPath === undefined ? {} : { telemetryPath }),
    ...(warning === undefined ? {} : { warning }),
    ...(overlayWarning === undefined ? {} : { overlayWarning }),
    ...(disposition === undefined ? {} : { nativePathDisposition: disposition }),
  };
}

function encodeOptionalString(key: string, value: unknown): JsonObject {
  const readable = readNonEmptyString(value);
  return readable === undefined ? {} : { [key]: readable };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
