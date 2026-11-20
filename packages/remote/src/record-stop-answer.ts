import type { DaemonArtifact } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';

/**
 * #4518: the one shape a remote `record stop` answer reaches the caller in. The client builds it
 * from named, validated daemon facts plus the files it published itself; nothing else in the answer
 * survives. Local paths and delivery disclosures (`outPath`, `telemetryPath`, chunk paths, artifact
 * `localPath`, `savedScript`, `recordingDestinationWarnings`, `scriptDeliveryFailure`) come only
 * from this client's own deliveries, and daemon warning text is kept as `daemonWarnings`.
 */

/** The `details.reason` a remote record stop answer publishes when it cannot be delivered safely. */
const RECORD_STOP_ANSWER_REASONS = {
  /** Two artifacts share an id or a role, or a chunk artifact names no chunk of the answer. */
  invalid: 'record_stop_answer_invalid',
} as const;

const RECORDING_ROLES = new Set(['outPath', 'telemetryPath', 'chunkPath']);

/** One recording file to download, bound to its validated role and, for a chunk, its index. */
export type RecordingDownload = Readonly<{
  artifact: DaemonArtifact & { artifactId: string };
  chunkIndex: number | undefined;
}>;

/**
 * Binds every downloadable recording artifact to its role and chunk before anything is fetched.
 * The first chunk is the `outPath` file; each later chunk is the `chunkPath` artifact whose daemon
 * path names it. An artifact without an id or a recording role downloads nothing.
 */
export function planRecordingDownloads(data: Record<string, unknown> | undefined): {
  downloads: RecordingDownload[];
  chunkIndexes: number[];
} {
  const chunks = readChunks(data?.chunks);
  const artifacts = (Array.isArray(data?.artifacts) ? data.artifacts : []).filter(
    (artifact): artifact is DaemonArtifact & { artifactId: string } =>
      isRecord(artifact) &&
      typeof artifact.artifactId === 'string' &&
      RECORDING_ROLES.has(artifact.field as string),
  );
  const claimed = new Set<string>();
  const claim = (key: string) => {
    if (claimed.has(key)) throw invalidAnswer(`The recording answer names ${key} twice.`);
    claimed.add(key);
  };
  const downloads = artifacts.map((artifact) => {
    claim(`artifact ${artifact.artifactId}`);
    if (artifact.field !== 'chunkPath') claim(artifact.field);
    const chunkIndex =
      artifact.field === 'outPath' && chunks.length > 0 ? 0 : chunkOf(artifact, chunks);
    if (chunkIndex !== undefined) claim(`chunk ${chunkIndex}`);
    return { artifact, chunkIndex };
  });
  return { downloads, chunkIndexes: chunks.map((chunk) => chunk.index) };
}

function chunkOf(
  artifact: DaemonArtifact,
  chunks: ReadonlyArray<{ index: number; path: string }>,
): number | undefined {
  if (artifact.field !== 'chunkPath') return undefined;
  const matches = chunks.filter(
    (chunk) =>
      chunk.index > 0 && (chunk.path === artifact.path || chunk.path === artifact.localPath),
  );
  if (matches.length !== 1) {
    throw invalidAnswer(`Chunk artifact ${artifact.artifactId} names no single chunk.`);
  }
  return matches[0]!.index;
}

function readChunks(value: unknown): Array<{ index: number; path: string }> {
  const chunks = (Array.isArray(value) ? value : []).flatMap((chunk) =>
    isRecord(chunk) && Number.isSafeInteger(chunk.index) && typeof chunk.path === 'string'
      ? [{ index: chunk.index as number, path: chunk.path }]
      : [],
  );
  if (new Set(chunks.map((chunk) => chunk.index)).size !== chunks.length) {
    throw invalidAnswer('The recording answer names one chunk index twice.');
  }
  return chunks;
}

function invalidAnswer(message: string): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: RECORD_STOP_ANSWER_REASONS.invalid,
  });
}

/** The daemon facts a record stop result keeps, each with the one type it may have. */
const RESULT_FACTS = {
  recording: 'string',
  durationMs: 'number',
  capturedDurationMs: 'number',
  recordingBackend: 'string',
  recordingScope: 'string',
  recorder: 'string',
  nativePathDisposition: 'string',
  recordOnlySession: 'boolean',
  showTouches: 'boolean',
} as const;

/** The facts record stop error details keep. */
const ERROR_FACTS = {
  reason: 'string',
  hint: 'string',
  dispatched: 'string',
  requestId: 'string',
  recorder: 'string',
  retriable: 'boolean',
} as const;

/**
 * The remote record stop result: validated daemon facts, then the client's own fields (published
 * paths, artifacts and delivery disclosures), and chunk paths only for chunks this client wrote.
 */
export function projectRecordStopResult(
  peer: Record<string, unknown> | undefined,
  local: Record<string, unknown>,
  chunkPaths: ReadonlyMap<number, string>,
  chunkIndexes: readonly number[],
): Record<string, unknown> {
  const app = peer?.activeSessionApp;
  const chunks = chunkIndexes.map((index) =>
    chunkPaths.has(index) ? { index, path: chunkPaths.get(index) } : { index },
  );
  return {
    ...pickFacts(peer, RESULT_FACTS),
    ...(isRecord(app) && typeof app.bundleId === 'string'
      ? { activeSessionApp: pickFacts(app, { bundleId: 'string', name: 'string' }) }
      : {}),
    ...local,
    ...(chunks.length > 0 ? { chunks } : {}),
  };
}

/** Remote record stop error details: named scalar facts and the daemon's warning text only. */
export function projectRecordStopErrorDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return details && pickFacts(details, ERROR_FACTS);
}

/**
 * The named facts of `source` whose value has the declared type, plus the daemon's own warning text
 * as `daemonWarnings`, which never enters the client-owned `warnings` channel.
 */
function pickFacts(
  source: Record<string, unknown> | undefined,
  types: Readonly<Record<string, 'string' | 'number' | 'boolean'>>,
): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(types)) {
    if (source && typeof source[key] === type) facts[key] = source[key];
  }
  const listed = Array.isArray(source?.warnings) ? source.warnings : [];
  const daemonWarnings = [source?.warning, source?.overlayWarning, ...listed].filter(
    (warning): warning is string => typeof warning === 'string' && warning.length > 0,
  );
  return daemonWarnings.length > 0 ? { ...facts, daemonWarnings } : facts;
}
