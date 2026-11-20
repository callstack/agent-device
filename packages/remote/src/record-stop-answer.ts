import path from 'node:path';
import type { DaemonArtifact } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';

/** The `details.reason` a remote record stop answer publishes when it cannot be delivered safely. */
const RECORD_STOP_ANSWER_REASONS = {
  /** Two artifacts share an id or a role, or a chunk artifact names no chunk of the answer. */
  invalid: 'record_stop_answer_invalid',
} as const;

const RECORDING_ROLES = new Set(['outPath', 'telemetryPath', 'chunkPath']);

type DeliverableArtifact = DaemonArtifact & { artifactId: string };
type RecordingDestination = { path: string; fallback: boolean };
type RecordStopDelivery =
  | { kind: 'script'; artifact: DeliverableArtifact }
  | {
      kind: 'recording';
      artifact: DeliverableArtifact;
      chunkIndex: number | undefined;
      destination: RecordingDestination;
    };

/**
 * Binds every downloadable recording artifact to its role and chunk before anything is fetched.
 * Artifact ids are claimed across every deliverable artifact, session scripts included. The
 * `outPath` file is chunk 0 and each later chunk is the `chunkPath` artifact, each only when its
 * daemon path names that chunk. An artifact without an id or a recording role downloads nothing.
 */
export function planRecordingDownloads(
  data: Record<string, unknown> | undefined,
  destinationOf: {
    recording(artifact: DeliverableArtifact): RecordingDestination;
    script(artifact: DeliverableArtifact): string | undefined;
  },
): { deliveries: RecordStopDelivery[]; chunkIndexes: number[] } {
  const chunks = readChunks(data?.chunks);
  const claimed = new Set<string>();
  const claim = (key: string) => {
    if (claimed.has(key)) throw invalidAnswer(`The recording answer names ${key} twice.`);
    claimed.add(key);
  };
  const deliveries: RecordStopDelivery[] = [];
  const paths: string[] = [];
  for (const artifact of readDeliverableArtifacts(data?.artifacts)) {
    claim(`artifact ${artifact.artifactId}`);
    if (artifact.field === 'savedScript') {
      const scriptPath = destinationOf.script(artifact);
      if (scriptPath !== undefined) paths.push(scriptPath);
      deliveries.push({ kind: 'script', artifact });
      continue;
    }
    if (artifact.field !== 'chunkPath') claim(artifact.field);
    const chunkIndex = chunkOf(artifact, chunks);
    if (chunkIndex !== undefined) claim(`chunk ${chunkIndex}`);
    const destination = destinationOf.recording(artifact);
    paths.push(destination.path);
    deliveries.push({ kind: 'recording', artifact, chunkIndex, destination });
  }
  claimDistinctDestinations(paths);
  return { deliveries, chunkIndexes: chunks.map((chunk) => chunk.index) };
}

function readDeliverableArtifacts(value: unknown): DeliverableArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.filter((artifact: unknown): artifact is DeliverableArtifact => {
    if (!isRecord(artifact) || typeof artifact.artifactId !== 'string') return false;
    if (artifact.artifactType === 'session-script') return artifact.field === 'savedScript';
    return typeof artifact.field === 'string' && RECORDING_ROLES.has(artifact.field);
  });
}

/** The chunk an artifact's daemon path names; a contradictory identity refuses the answer. */
function chunkOf(
  artifact: DaemonArtifact,
  chunks: ReadonlyArray<{ index: number; path: string }>,
): number | undefined {
  if (artifact.field === 'telemetryPath') return undefined;
  const first = artifact.field === 'outPath';
  if (first && !chunks.some(({ index }) => index === 0)) return undefined;
  const matches = chunks.filter(
    (chunk) => chunk.path === artifact.path || chunk.path === artifact.localPath,
  );
  if (matches.length !== 1 || (matches[0]!.index === 0) !== first) {
    throw invalidAnswer(`Artifact ${artifact.artifactId} names no single chunk.`);
  }
  return matches[0]!.index;
}

/** Refuses two recording files that would land at one local path (compared case-insensitively). */
function claimDistinctDestinations(paths: readonly string[]): void {
  const seen = new Set<string>();
  for (const destination of paths) {
    const key = path.resolve(destination).normalize('NFC').toLowerCase();
    if (seen.has(key)) throw invalidAnswer('Two artifacts share a destination.');
    seen.add(key);
  }
}

function readChunks(value: unknown): Array<{ index: number; path: string }> {
  const chunks = (Array.isArray(value) ? value : []).flatMap((chunk) =>
    isRecord(chunk) &&
    typeof chunk.index === 'number' &&
    Number.isSafeInteger(chunk.index) &&
    chunk.index >= 0 &&
    typeof chunk.path === 'string'
      ? [{ index: chunk.index, path: chunk.path }]
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
  delivered: readonly DaemonArtifact[],
  chunkPaths: ReadonlyMap<number, string>,
  chunkIndexes: readonly number[],
): Record<string, unknown> {
  const app = peer?.activeSessionApp;
  const chunks = chunkIndexes.map((index) =>
    chunkPaths.has(index) ? { index, path: chunkPaths.get(index) } : { index },
  );
  return {
    ...pickFacts(peer, RESULT_FACTS),
    ...daemonWarningsOf(peer),
    ...(isRecord(app) && typeof app.bundleId === 'string'
      ? { activeSessionApp: pickFacts(app, { bundleId: 'string', name: 'string' }) }
      : {}),
    ...local,
    artifacts: delivered.map(({ artifactId, field, artifactType, fileName, localPath }) => ({
      artifactId,
      field,
      ...(typeof artifactType === 'string' ? { artifactType } : {}),
      ...(typeof fileName === 'string' ? { fileName } : {}),
      localPath,
    })),
    ...(chunks.length > 0 ? { chunks } : {}),
  };
}

/** Remote record stop error details: named scalar facts and the daemon's warning text only. */
export function projectRecordStopErrorDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return details && { ...pickFacts(details, ERROR_FACTS), ...daemonWarningsOf(details) };
}

/** The named facts of `source` whose value has the declared type. */
function pickFacts(
  source: Record<string, unknown> | undefined,
  types: Readonly<Record<string, 'string' | 'number' | 'boolean'>>,
): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(types)) {
    if (source && typeof source[key] === type) facts[key] = source[key];
  }
  return facts;
}

/** The daemon's own warning text as `daemonWarnings`, never the client-owned `warnings` channel. */
function daemonWarningsOf(source: Record<string, unknown> | undefined): {
  daemonWarnings?: string[];
} {
  const listed = Array.isArray(source?.warnings) ? source.warnings : [];
  const daemonWarnings = [source?.warning, source?.overlayWarning, ...listed].filter(
    (warning): warning is string => typeof warning === 'string' && warning.length > 0,
  );
  return daemonWarnings.length > 0 ? { daemonWarnings } : {};
}
