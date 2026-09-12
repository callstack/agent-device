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

/**
 * A finished export outlives the request that produced it: a caller that stopped waiting while the
 * daemon was still exporting comes back for the recording with a later `record stop`. Encoding and
 * decoding live together so the manifest cannot grow a stop-response field that recovery drops.
 *
 * Decoding is all-or-nothing. A manifest that fails to decode replays nothing, instead of handing
 * back a stop response that quietly lost a chunk or the caller-side output path — that path is what
 * makes the recording downloadable at all when the daemon runs on another host.
 */
export type ScreenRecordingCompletionDecode =
  | Readonly<{ status: 'decoded'; completion: ScreenRecordingCompletion }>
  | Readonly<{ status: 'invalid'; reason: string }>;

const DAMAGED = Symbol('damaged');

export function encodeScreenRecordingCompletionMetadata(
  completion: ScreenRecordingCompletion,
): JsonObject {
  return {
    backend: completion.backend,
    outputPath: completion.outPath,
    startedAt: completion.startedAt,
    completedAt: completion.completedAt,
    scope: completion.scope,
    showTouches: completion.showTouches,
    recordOnlySession: completion.recordOnlySession,
    ...(completion.clientOutPath === undefined ? {} : { clientOutPath: completion.clientOutPath }),
    ...(completion.telemetryPath === undefined ? {} : { telemetryPath: completion.telemetryPath }),
    ...(completion.warning === undefined ? {} : { warning: completion.warning }),
    ...(completion.overlayWarning === undefined
      ? {}
      : { overlayWarning: completion.overlayWarning }),
    ...(completion.activeSessionApp === undefined
      ? {}
      : { activeSessionApp: encodeAppIdentity(completion.activeSessionApp) }),
    ...(completion.chunks === undefined ? {} : { chunks: completion.chunks.map(encodeChunk) }),
  };
}

export function decodeScreenRecordingCompletionMetadata(
  metadata: JsonObject | undefined,
): ScreenRecordingCompletionDecode {
  if (metadata === undefined) return invalid('the manifest carries no completion metadata');
  const backend = readText(metadata.backend);
  if (isDamaged(backend)) return invalid('backend');
  const outPath = readText(metadata.outputPath);
  if (isDamaged(outPath)) return invalid('outputPath');
  const startedAt = readNumber(metadata.startedAt);
  if (isDamaged(startedAt)) return invalid('startedAt');
  const completedAt = readNumber(metadata.completedAt);
  if (isDamaged(completedAt)) return invalid('completedAt');
  const scope = readScope(metadata.scope);
  if (isDamaged(scope)) return invalid('scope');
  const showTouches = readBoolean(metadata.showTouches);
  if (isDamaged(showTouches)) return invalid('showTouches');
  const recordOnlySession = readBoolean(metadata.recordOnlySession);
  if (isDamaged(recordOnlySession)) return invalid('recordOnlySession');
  const clientOutPath = readOptionalText(metadata.clientOutPath);
  if (isDamaged(clientOutPath)) return invalid('clientOutPath');
  const telemetryPath = readOptionalText(metadata.telemetryPath);
  if (isDamaged(telemetryPath)) return invalid('telemetryPath');
  const warning = readOptionalText(metadata.warning);
  if (isDamaged(warning)) return invalid('warning');
  const overlayWarning = readOptionalText(metadata.overlayWarning);
  if (isDamaged(overlayWarning)) return invalid('overlayWarning');
  const activeSessionApp = readAppIdentity(metadata.activeSessionApp);
  if (isDamaged(activeSessionApp)) return invalid('activeSessionApp');
  const chunks = readChunks(metadata.chunks);
  if (isDamaged(chunks)) return invalid('chunks');
  return {
    status: 'decoded',
    completion: {
      backend,
      outPath,
      startedAt,
      completedAt,
      scope,
      showTouches,
      recordOnlySession,
      ...(clientOutPath === undefined ? {} : { clientOutPath }),
      ...(telemetryPath === undefined ? {} : { telemetryPath }),
      ...(warning === undefined ? {} : { warning }),
      ...(overlayWarning === undefined ? {} : { overlayWarning }),
      ...(activeSessionApp === undefined ? {} : { activeSessionApp }),
      ...(chunks === undefined ? {} : { chunks }),
    },
  };
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
