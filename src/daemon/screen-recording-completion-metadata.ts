import type { JsonObject } from '@agent-device/contracts/client';
import {
  RECORDING_SCOPE_VALUES,
  type RecordingAppIdentity,
  type RecordingScope,
} from '@agent-device/contracts/recording';
import type {
  ScreenRecordingChunk,
  ScreenRecordingCompletion,
} from '@agent-device/contracts/screen-recording-runtime';
import { isRecord } from '@agent-device/kernel/record';
import { screenRecordingCompletionFields } from './screen-recording-session-resource.ts';

/**
 * The reading half of a finished recording's manifest metadata; `screenRecordingCompletionFields` in
 * `screen-recording-session-resource.ts` owns the keys and writes the values.
 *
 * A finished export outlives the request that produced it: a caller that stopped waiting while the
 * daemon was still exporting comes back for the recording with a later `record stop`. Decoding is
 * all-or-nothing — a manifest that fails to decode replays nothing, instead of handing back a stop
 * response that quietly lost a chunk or the caller-side output path. That path is what makes the
 * recording downloadable at all when the daemon runs on another host.
 *
 * The mapped type obliges every completion property to have a reader, so a field that gains a writer
 * cannot be decoded away.
 */
export type ScreenRecordingCompletionDecode =
  | Readonly<{ status: 'decoded'; completion: ScreenRecordingCompletion }>
  | Readonly<{ status: 'invalid'; reason: string }>;

const DAMAGED = Symbol('damaged');

const COMPLETION_READERS = {
  backend: readText,
  outPath: readText,
  startedAt: readNumber,
  completedAt: readNumber,
  scope: readScope,
  showTouches: readBoolean,
  recordOnlySession: readBoolean,
  clientOutPath: readOptionalText,
  telemetryPath: readOptionalText,
  warning: readOptionalText,
  overlayWarning: readOptionalText,
  activeSessionApp: readAppIdentity,
  chunks: readChunks,
} satisfies {
  [K in keyof ScreenRecordingCompletion]: (
    value: unknown,
  ) => ScreenRecordingCompletion[K] | typeof DAMAGED;
};

export function decodeScreenRecordingCompletionMetadata(
  metadata: JsonObject | undefined,
): ScreenRecordingCompletionDecode {
  if (metadata === undefined) return invalid('the manifest carries no completion metadata');
  const completion: Record<string, unknown> = {};
  for (const name of Object.keys(COMPLETION_READERS) as (keyof ScreenRecordingCompletion)[]) {
    const key = screenRecordingCompletionFields[name].key;
    const value = COMPLETION_READERS[name](metadata[key]);
    if (value === DAMAGED) return invalid(key);
    if (value !== undefined) completion[name] = value;
  }
  return { status: 'decoded', completion: completion as ScreenRecordingCompletion };
}

function invalid(field: string): ScreenRecordingCompletionDecode {
  return { status: 'invalid', reason: `${field} is missing or damaged` };
}

function readAppIdentity(value: unknown): RecordingAppIdentity | undefined | typeof DAMAGED {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return DAMAGED;
  const bundleId = readText(value.bundleId);
  if (isDamaged(bundleId)) return DAMAGED;
  const name = readOptionalText(value.name);
  if (isDamaged(name)) return DAMAGED;
  return { bundleId, ...(name === undefined ? {} : { name }) };
}

function readChunks(value: unknown): readonly ScreenRecordingChunk[] | undefined | typeof DAMAGED {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return DAMAGED;
  const chunks: ScreenRecordingChunk[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return DAMAGED;
    const index = readInteger(entry.index);
    const path = readText(entry.path);
    const clientOutPath = readOptionalText(entry.clientOutPath);
    if (isDamaged(index) || isDamaged(path) || isDamaged(clientOutPath)) return DAMAGED;
    chunks.push({ index, path, ...(clientOutPath === undefined ? {} : { clientOutPath }) });
  }
  return chunks;
}

function isDamaged<T>(value: T | typeof DAMAGED): value is typeof DAMAGED {
  return value === DAMAGED;
}

function readText(value: unknown): string | typeof DAMAGED {
  return typeof value === 'string' && value.length > 0 ? value : DAMAGED;
}

function readOptionalText(value: unknown): string | undefined | typeof DAMAGED {
  if (value === undefined) return undefined;
  return readText(value);
}

function readNumber(value: unknown): number | typeof DAMAGED {
  return typeof value === 'number' && Number.isFinite(value) ? value : DAMAGED;
}

function readInteger(value: unknown): number | typeof DAMAGED {
  return typeof value === 'number' && Number.isInteger(value) ? value : DAMAGED;
}

function readBoolean(value: unknown): boolean | typeof DAMAGED {
  return typeof value === 'boolean' ? value : DAMAGED;
}

function readScope(value: unknown): RecordingScope | typeof DAMAGED {
  return RECORDING_SCOPE_VALUES.find((scope) => scope === value) ?? DAMAGED;
}
