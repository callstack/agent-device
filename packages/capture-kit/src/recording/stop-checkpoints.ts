import type { JsonObject } from '@agent-device/contracts/client';
import {
  isNativePathDisposition,
  type NativePathDisposition,
} from '@agent-device/contracts/recording-native-path';
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

type StopFinalization = NonNullable<RecordingStopProgress['finalization']>;

type StopFinalizationFields = Readonly<{
  telemetryPath?: unknown;
  warning?: unknown;
  overlayWarning?: unknown;
  nativePathDisposition?: unknown;
}>;

const FINALIZATION_STRING_KEYS = ['telemetryPath', 'warning', 'overlayWarning'] as const;

function readFinalization(value: unknown): StopFinalization | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const fields: StopFinalizationFields = value;
  const disposition = readDeclaredDisposition(fields.nativePathDisposition);
  if (disposition === 'undeclared') return undefined;
  const finalization: { -readonly [K in keyof StopFinalization]?: StopFinalization[K] } = {
    ...readFinalizationStrings(fields),
    ...(disposition === undefined ? {} : { nativePathDisposition: disposition }),
  };
  // A checkpoint that names nothing the finalizer learned is worse than none: the next attempt would
  // serve an empty result as though the finalizer had run, and never redo the step that did not.
  return Object.keys(finalization).length === 0 ? undefined : finalization;
}

function readDeclaredDisposition(value: unknown): NativePathDisposition | 'undeclared' | undefined {
  if (value === undefined) return undefined;
  return isNativePathDisposition(value) ? value : 'undeclared';
}

function readFinalizationStrings(fields: StopFinalizationFields): {
  -readonly [K in (typeof FINALIZATION_STRING_KEYS)[number]]?: string;
} {
  const readable: { -readonly [K in (typeof FINALIZATION_STRING_KEYS)[number]]?: string } = {};
  for (const key of FINALIZATION_STRING_KEYS) {
    const value = readNonEmptyString(fields[key]);
    if (value !== undefined) readable[key] = value;
  }
  return readable;
}

function encodeOptionalString(key: string, value: unknown): JsonObject {
  const readable = readNonEmptyString(value);
  return readable === undefined ? {} : { [key]: readable };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
