import fs from 'node:fs';
import path from 'node:path';
import type { RecordingStopCommandResult } from '@agent-device/contracts/recording';
import type { DaemonArtifact } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { readResponseWarnings } from '@agent-device/kernel/success-text';

const RECORD_STOP_ANSWER_REASONS = {
  invalid: 'record_stop_answer_invalid',
  missingRole: 'recording_artifact_role_missing',
} as const;

const RECORDING_ROLES = {
  recording: { artifactType: 'screen-recording', field: 'outPath' },
  telemetry: { artifactType: 'screen-recording-telemetry', field: 'telemetryPath' },
  chunk: { artifactType: 'screen-recording-chunk', field: 'chunkPath' },
} as const satisfies Record<
  NonNullable<DaemonArtifact['role']>,
  Pick<DaemonArtifact, 'artifactType' | 'field'>
>;

type DeliverableArtifact = DaemonArtifact & { artifactId: string };
type RecordingDestination = { path: string; fallback: boolean };
type RecordStopDelivery =
  | { kind: 'script'; artifact: DeliverableArtifact }
  | {
      kind: 'recording';
      artifact: DeliverableArtifact;
      destination: RecordingDestination;
      url: URL;
    };

export function planRecordingDownloads(
  data: Record<string, unknown> | undefined,
  artifactUrl: (id: string) => URL,
  destinationOf: {
    recording(artifact: DeliverableArtifact): RecordingDestination;
    script(artifact: DeliverableArtifact): string | undefined;
  },
): { deliveries: RecordStopDelivery[]; missingRole: boolean } {
  const claimed = new Set<string>();
  const claim = (key: string) => {
    if (claimed.has(key)) throw invalidAnswer(`The recording answer names ${key} twice.`);
    claimed.add(key);
  };
  const claimDestination = (destination: string | undefined) => {
    if (destination === undefined) return;
    const parent = resolvedParent(path.dirname(destination));
    const key = path.join(parent, path.basename(destination)).normalize('NFC').toLowerCase();
    claim(`destination ${key}`);
  };
  const deliveries: RecordStopDelivery[] = [];
  let missingRole = false;
  const route = artifactUrl('');
  for (const artifact of Array.isArray(data?.artifacts) ? data.artifacts : []) {
    if (!isRecord(artifact)) continue;
    if (artifact.role === undefined) {
      if (artifact.artifactType !== 'session-script' || artifact.field !== 'savedScript') {
        missingRole = true;
      } else if (typeof artifact.artifactId === 'string') {
        const script = artifact as DeliverableArtifact;
        claim(`artifact ${script.artifactId}`);
        claimDestination(destinationOf.script(script));
        deliveries.push({ kind: 'script', artifact: script });
      }
      continue;
    }
    const recording = readRecordingArtifact(artifact, claim);
    const id = recording.artifactId;
    const url = artifactUrl(id);
    if (url.href !== route.href + encodeURIComponent(id))
      throw invalidAnswer('Invalid recording artifact URL.');
    const destination = destinationOf.recording(recording);
    claimDestination(destination.path);
    deliveries.push({ kind: 'recording', artifact: recording, destination, url });
  }
  return { deliveries, missingRole };
}

function readRecordingArtifact(
  artifact: Record<string, unknown>,
  claim: (key: string) => void,
): DeliverableArtifact {
  const { role, chunkIndex } = artifact;
  if (typeof role !== 'string' || !Object.hasOwn(RECORDING_ROLES, role)) {
    throw invalidAnswer('Unknown recording artifact role.');
  }
  const { artifactType, field } = RECORDING_ROLES[role as keyof typeof RECORDING_ROLES];
  if (artifact.artifactType !== artifactType) {
    throw invalidAnswer('The recording artifact type contradicts its role.');
  }
  if (role !== 'chunk') claim(role);
  if (chunkIndex !== undefined || role === 'chunk') {
    if (
      role === 'telemetry' ||
      typeof chunkIndex !== 'number' ||
      !Number.isSafeInteger(chunkIndex) ||
      chunkIndex < 1
    ) {
      throw invalidAnswer('Invalid recording chunk index.');
    }
    claim(`chunk ${chunkIndex}`);
  }
  const artifactId = opaqueArtifactId(artifact.artifactId);
  claim(`artifact ${artifactId}`);
  return { ...artifact, field, artifactId } as DeliverableArtifact;
}

function opaqueArtifactId(id: unknown): string {
  if (
    typeof id === 'string' &&
    id &&
    id !== '.' &&
    id !== '..' &&
    !/[\\/\0\p{Surrogate}]/u.test(id)
  )
    return id;
  throw invalidAnswer('Invalid recording artifact ID.');
}

function resolvedParent(directory: string): string {
  const absolute = path.resolve(directory);
  try {
    return fs.realpathSync(absolute);
  } catch (error) {
    const parent = path.dirname(absolute);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === absolute) return absolute;
    return path.join(resolvedParent(parent), path.basename(absolute));
  }
}

function invalidAnswer(message: string): AppError {
  return new AppError('COMMAND_FAILED', message, { reason: RECORD_STOP_ANSWER_REASONS.invalid });
}

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

const ERROR_FACTS = {
  reason: 'string',
  hint: 'string',
  dispatched: 'string',
  requestId: 'string',
  recorder: 'string',
  retriable: 'boolean',
} as const;

export function projectRecordStopResult(
  peer: Record<string, unknown> | undefined,
  local: Record<string, unknown>,
  delivered: readonly DaemonArtifact[],
  missingRole: boolean,
): Record<string, unknown> {
  const app = peer?.activeSessionApp;
  const chunks: NonNullable<RecordingStopCommandResult['chunks']> = [];
  const paths: Pick<RecordingStopCommandResult, 'outPath' | 'telemetryPath'> = {};
  const artifacts = delivered.map(
    ({ artifactId, field, artifactType, role, chunkIndex, fileName, localPath }) => {
      if (role === 'recording') paths.outPath = localPath;
      if (role === 'telemetry') paths.telemetryPath = localPath;
      if (role && chunkIndex !== undefined && localPath !== undefined)
        chunks.push({ index: chunkIndex, path: localPath });
      return {
        artifactId,
        field,
        artifactType,
        role,
        chunkIndex: role ? chunkIndex : undefined,
        fileName: typeof fileName === 'string' ? fileName : undefined,
        localPath,
      };
    },
  );
  return {
    ...pickFacts(peer, RESULT_FACTS),
    ...daemonWarningsOf(peer),
    ...(isRecord(app) && typeof app.bundleId === 'string'
      ? { activeSessionApp: pickFacts(app, { bundleId: 'string', name: 'string' }) }
      : {}),
    ...local,
    ...paths,
    artifacts,
    ...(chunks.length ? { chunks: chunks.sort((left, right) => left.index - right.index) } : {}),
    ...(missingRole ? missingRoleWarning(local) : {}),
  };
}

function missingRoleWarning(local: Record<string, unknown>) {
  return {
    recordingArtifactWarning: { reason: RECORD_STOP_ANSWER_REASONS.missingRole },
    warnings: [
      ...readResponseWarnings(local),
      'The remote daemon omitted a recording artifact role. The client skipped that artifact.',
    ],
  };
}

export function projectRecordStopErrorDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return details && { ...pickFacts(details, ERROR_FACTS), ...daemonWarningsOf(details) };
}

function pickFacts(
  source: Record<string, unknown> | undefined,
  types: Readonly<Record<string, 'string' | 'number' | 'boolean'>>,
): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(types)) {
    const value = source?.[key];
    if (typeof value === type && (type !== 'number' || Number.isFinite(value))) facts[key] = value;
  }
  return facts;
}

function daemonWarningsOf(source: Record<string, unknown> | undefined): {
  daemonWarnings?: string[];
} {
  const listed = Array.isArray(source?.warnings) ? source.warnings : [];
  const daemonWarnings = [source?.warning, source?.overlayWarning, ...listed].filter(
    (warning): warning is string => typeof warning === 'string' && warning.length > 0,
  );
  return daemonWarnings.length > 0 ? { daemonWarnings } : {};
}
