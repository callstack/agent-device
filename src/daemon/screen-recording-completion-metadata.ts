import type { JsonObject, JsonValue } from '@agent-device/contracts/client';
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

/**
 * A finished export outlives the request that produced it: a caller that stopped waiting while the
 * daemon was still exporting comes back for the recording with a later `record stop`. One codec per
 * completion property drives both directions, and the mapped declaration refuses a property with no
 * codec, so the manifest cannot grow a stop-response field that recovery silently drops.
 *
 * Decoding is all-or-nothing. A manifest that fails to decode replays nothing, instead of handing
 * back a stop response that quietly lost a chunk or the caller-side output path — that path is what
 * makes the recording downloadable at all when the daemon runs on another host.
 */
export type ScreenRecordingCompletionDecode =
  | Readonly<{ status: 'decoded'; completion: ScreenRecordingCompletion }>
  | Readonly<{ status: 'invalid'; reason: string }>;

const DAMAGED = Symbol('damaged');

type CompletionCodec<K extends keyof ScreenRecordingCompletion> = Readonly<{
  /** Key inside the durable manifest's completion metadata. */
  key: string;
  read: (value: unknown) => ScreenRecordingCompletion[K] | typeof DAMAGED;
  write: (completion: ScreenRecordingCompletion) => JsonValue | undefined;
}>;

type CompletionCodecs = {
  [K in keyof ScreenRecordingCompletion]: CompletionCodec<K>;
};

const COMPLETION_CODECS = {
  backend: { key: 'backend', read: readText, write: (c) => c.backend },
  outPath: { key: 'outputPath', read: readText, write: (c) => c.outPath },
  startedAt: { key: 'startedAt', read: readNumber, write: (c) => c.startedAt },
  completedAt: { key: 'completedAt', read: readNumber, write: (c) => c.completedAt },
  scope: { key: 'scope', read: readScope, write: (c) => c.scope },
  showTouches: { key: 'showTouches', read: readBoolean, write: (c) => c.showTouches },
  recordOnlySession: {
    key: 'recordOnlySession',
    read: readBoolean,
    write: (c) => c.recordOnlySession,
  },
  clientOutPath: {
    key: 'clientOutPath',
    read: readOptionalText,
    write: (c) => c.clientOutPath,
  },
  telemetryPath: { key: 'telemetryPath', read: readOptionalText, write: (c) => c.telemetryPath },
  warning: { key: 'warning', read: readOptionalText, write: (c) => c.warning },
  overlayWarning: {
    key: 'overlayWarning',
    read: readOptionalText,
    write: (c) => c.overlayWarning,
  },
  activeSessionApp: {
    key: 'activeSessionApp',
    read: readAppIdentity,
    write: (c) =>
      c.activeSessionApp === undefined ? undefined : encodeAppIdentity(c.activeSessionApp),
  },
  chunks: {
    key: 'chunks',
    read: readChunks,
    write: (c) => (c.chunks === undefined ? undefined : c.chunks.map(encodeChunk)),
  },
} satisfies CompletionCodecs;

export function encodeScreenRecordingCompletionMetadata(
  completion: ScreenRecordingCompletion,
): JsonObject {
  const metadata: Record<string, JsonValue> = {};
  for (const codec of Object.values(COMPLETION_CODECS)) {
    const value = codec.write(completion);
    if (value !== undefined) metadata[codec.key] = value;
  }
  return metadata;
}

export function decodeScreenRecordingCompletionMetadata(
  metadata: JsonObject | undefined,
): ScreenRecordingCompletionDecode {
  if (metadata === undefined) return invalid('the manifest carries no completion metadata');
  const completion: Record<string, unknown> = {};
  for (const [name, codec] of Object.entries(COMPLETION_CODECS)) {
    const value = codec.read(metadata[codec.key]);
    if (value === DAMAGED) return invalid(codec.key);
    if (value !== undefined) completion[name] = value;
  }
  return { status: 'decoded', completion: completion as ScreenRecordingCompletion };
}

function invalid(field: string): ScreenRecordingCompletionDecode {
  return { status: 'invalid', reason: `${field} is missing or damaged` };
}

function encodeAppIdentity(app: RecordingAppIdentity): JsonObject {
  return {
    bundleId: app.bundleId,
    ...(app.name === undefined ? {} : { name: app.name }),
  };
}

function encodeChunk(chunk: ScreenRecordingChunk): JsonObject {
  return {
    index: chunk.index,
    path: chunk.path,
    ...(chunk.clientOutPath === undefined ? {} : { clientOutPath: chunk.clientOutPath }),
  };
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
