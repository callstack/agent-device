import type { JsonObject, JsonValue } from '@agent-device/contracts/client';
import { isNativePathDisposition } from '@agent-device/contracts/recording-native-path';
import type {
  RecordingStopProgress,
  ScreenRecordingFinalization,
} from '@agent-device/contracts/recording-stop-progress';
import {
  type StopObservation,
  isStopObservation,
} from '@agent-device/contracts/recording-stop-observation';
import type { ScreenRecordingChunk } from '@agent-device/contracts/screen-recording-runtime';

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
const STOPPED_AT_KEY = 'stoppedAtMs';
const RECORDER_WARNING_KEY = 'stopRecorderWarning';
const COLLECTED_PATH_KEY = 'collectedPath';
const EXPORT_PATH_KEY = 'exportPath';
const FINALIZATION_KEY = 'stopFinalization';

/** A journaled value that is present and unreadable, which makes the whole finalization untrusted. */
const UNREADABLE = Symbol('unreadable');

type FieldCodec<T> = Readonly<{
  encode(value: T): JsonValue;
  /** `undefined` drops only this field; `UNREADABLE` refuses the finalization it belongs to. */
  read(value: unknown): T | undefined | typeof UNREADABLE;
}>;

/**
 * One codec per finalization field, keyed over every field the finalizer can return. A field added to
 * `ScreenRecordingFinalization` does not compile until it has a codec here, so a replayed stop cannot
 * serve less than the stop that journaled it.
 */
const FINALIZATION_FIELDS: {
  readonly [K in keyof ScreenRecordingFinalization]-?: FieldCodec<
    NonNullable<ScreenRecordingFinalization[K]>
  >;
} = {
  telemetryPath: optionalString(),
  warning: optionalString(),
  overlayWarning: optionalString(),
  nativePathDisposition: {
    encode: (disposition) => disposition,
    read: (value) =>
      value === undefined ? undefined : isNativePathDisposition(value) ? value : UNREADABLE,
  },
  chunks: {
    encode: (chunks) => chunks.map(encodeChunk),
    read: (value) => (value === undefined ? undefined : (readChunks(value) ?? UNREADABLE)),
  },
  capturedDurationMs: {
    encode: (durationMs) => durationMs,
    read: (value) =>
      value === undefined ? undefined : isNonNegativeNumber(value) ? value : UNREADABLE,
  },
};

export function writeStopCheckpoint(fact: Partial<RecordingStopProgress>): JsonObject {
  return {
    ...(fact.observation === undefined
      ? {}
      : { [OBSERVATION_KEY]: encodeObservation(fact.observation) }),
    ...(fact.stoppedAtMs === undefined ? {} : { [STOPPED_AT_KEY]: fact.stoppedAtMs }),
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
  const stoppedAtMs = metadata?.[STOPPED_AT_KEY];
  const recorderWarning = readNonEmptyString(metadata?.[RECORDER_WARNING_KEY]);
  const collectedPath = readNonEmptyString(metadata?.[COLLECTED_PATH_KEY]);
  const exportPath = readNonEmptyString(metadata?.[EXPORT_PATH_KEY]);
  const finalization = readFinalization(metadata?.[FINALIZATION_KEY]);
  return {
    ...(isStopObservation(observation) ? { observation } : {}),
    ...(isNonNegativeNumber(stoppedAtMs) ? { stoppedAtMs } : {}),
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

function encodeFinalization(finalization: ScreenRecordingFinalization): JsonObject {
  const encoded: JsonObject = {};
  for (const key of finalizationKeys()) {
    const value = finalization[key];
    if (value === undefined) continue;
    const codec = FINALIZATION_FIELDS[key] as FieldCodec<typeof value>;
    encoded[key] = codec.encode(value);
  }
  return encoded;
}

function readFinalization(value: unknown): ScreenRecordingFinalization | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const fields = value as Readonly<Record<string, unknown>>;
  const finalization: Record<string, unknown> = {};
  for (const key of finalizationKeys()) {
    const read = FINALIZATION_FIELDS[key].read(fields[key]);
    if (read === UNREADABLE) return undefined;
    if (read !== undefined) finalization[key] = read;
  }
  // A checkpoint that names nothing the finalizer learned is worse than none: the next attempt would
  // serve an empty result as though the finalizer had run, and never redo the step that did not.
  return Object.keys(finalization).length === 0
    ? undefined
    : (finalization as ScreenRecordingFinalization);
}

function finalizationKeys(): readonly (keyof ScreenRecordingFinalization)[] {
  return Object.keys(FINALIZATION_FIELDS) as (keyof ScreenRecordingFinalization)[];
}

function optionalString(): FieldCodec<string> {
  return { encode: (value) => value, read: readNonEmptyString };
}

function encodeChunk(chunk: ScreenRecordingChunk): JsonObject {
  return {
    index: chunk.index,
    path: chunk.path,
    ...(chunk.clientOutPath === undefined ? {} : { clientOutPath: chunk.clientOutPath }),
  };
}

function readChunks(value: unknown): readonly ScreenRecordingChunk[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const chunks = value.map(readChunk);
  return chunks.every((chunk) => chunk !== undefined) ? chunks : undefined;
}

function readChunk(value: unknown): ScreenRecordingChunk | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { index, path, clientOutPath } = value as Readonly<Record<string, unknown>>;
  const readablePath = readNonEmptyString(path);
  const readableClientPath = readNonEmptyString(clientOutPath);
  if (!Number.isInteger(index) || (index as number) < 1 || readablePath === undefined)
    return undefined;
  if (clientOutPath !== undefined && readableClientPath === undefined) return undefined;
  return {
    index: index as number,
    path: readablePath,
    ...(readableClientPath === undefined ? {} : { clientOutPath: readableClientPath }),
  };
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
