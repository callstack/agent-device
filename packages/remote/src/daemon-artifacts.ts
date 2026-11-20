import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { RequestProgressSink } from '@agent-device/contracts/progress';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildRemoteTempArtifactDirPath,
  buildRemoteTempArtifactPath,
} from '@agent-device/contracts/daemon-http';
import { AppError, asAppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import {
  assertScriptTargetVacant,
  isOrdinaryEntryName,
  resolveScriptDestination,
} from '@agent-device/host-kit/file';
import { leaseScopeFromRequest } from '@agent-device/contracts/lease-scope';
import {
  appendRecordingExtensionWhenMissing,
  recordingExtensionForPlatform,
} from '@agent-device/capture-kit/recording-output-path';
import { parsePerfRuntimeRequest } from '@agent-device/capture-kit/perf-runtime-plan';
import type { RemoteArtifactDestinationMode } from './artifact-download.ts';
import type { SessionScriptDelivery } from './session-script-destination.ts';
import { uploadArtifact } from './upload-client.ts';
import { withUploadPreparationDeadline } from './upload-stream.ts';
import { createStderrUploadProgressReporter, type UploadProgressSink } from './upload-progress.ts';

// Mirrors `DEFAULT_TEST_ARTIFACTS_ROOT` in `packages/replay-test/src/internal/session-test-artifacts.ts`
// (the daemon's own default). Duplicated rather than imported: pulling it from
// `@agent-device/contracts` grew that package's pinned eager-import closure by 3 modules for one
// string (#2246) — not worth it for a literal that only ever changes alongside this comment.
const DEFAULT_TEST_ARTIFACTS_ROOT = '.agent-device/test-artifacts';

export type DaemonArtifactEndpoint = {
  baseUrl?: string;
  token: string;
};

export type PreparedRemoteRequest = {
  positionals: string[];
  flags?: DaemonWireRequest['flags'];
  installSource?: NonNullable<DaemonWireRequest['meta']>['installSource'];
  uploadedArtifactId?: string;
  clientArtifactPaths?: Record<string, string>;
};

export async function prepareRemoteRequestArtifacts(
  req: Omit<DaemonWireRequest, 'token'>,
  info: DaemonArtifactEndpoint,
  signal: AbortSignal,
  host: HostEnvironment,
  onProgress?: RequestProgressSink,
): Promise<PreparedRemoteRequest> {
  if (!isRemoteDaemon(info)) {
    return await prepareRemoteRequestArtifactsWithinBudget(req, info, signal, host, onProgress);
  }
  return await withUploadPreparationDeadline(
    signal,
    async (preparationSignal) =>
      await prepareRemoteRequestArtifactsWithinBudget(
        req,
        info,
        preparationSignal,
        host,
        onProgress,
      ),
  );
}

async function prepareRemoteRequestArtifactsWithinBudget(
  req: Omit<DaemonWireRequest, 'token'>,
  info: DaemonArtifactEndpoint,
  signal: AbortSignal,
  host: HostEnvironment,
  onProgress: RequestProgressSink | undefined,
): Promise<PreparedRemoteRequest> {
  const positionals = [...(req.positionals ?? [])];
  let flags = req.flags ? { ...req.flags } : undefined;
  let installSource = req.meta?.installSource;
  const clientArtifactPaths: Record<string, string> = {};
  let uploadedArtifactId: string | undefined;
  const uploadProgress = createStderrUploadProgressReporter(host.env, onProgress);

  if (!isRemoteDaemon(info)) {
    return createPreparedRemoteRequest({
      positionals,
      flags,
      installSource,
      uploadedArtifactId,
      clientArtifactPaths,
    });
  }

  flags = prepareRemoteScriptOutput(req, flags, clientArtifactPaths, host);
  flags = applyRemoteArtifactCommand(req, positionals, flags, clientArtifactPaths, host);
  const remoteInstallSource = await prepareRemoteInstallSource(
    req,
    info,
    uploadProgress,
    signal,
    host,
  );
  if (remoteInstallSource) {
    installSource = remoteInstallSource.installSource;
    uploadedArtifactId = remoteInstallSource.uploadedArtifactId ?? uploadedArtifactId;
  }

  const baseResult = (): PreparedRemoteRequest =>
    createPreparedRemoteRequest({
      positionals,
      flags,
      installSource,
      uploadedArtifactId,
      clientArtifactPaths,
    });

  if (req.command !== 'install' && req.command !== 'reinstall') return baseResult();
  const installPackageResult = await prepareRemoteInstallPackage(
    req,
    info,
    positionals,
    uploadProgress,
    signal,
    host,
  );
  uploadedArtifactId = installPackageResult ?? uploadedArtifactId;
  return baseResult();
}

/**
 * A remote `open --save-script` names a caller file. The daemon allocates its own output and
 * returns each script version as an artifact, which the client downloads to that file.
 */
function prepareRemoteScriptOutput(
  req: Omit<DaemonWireRequest, 'token'>,
  flags: DaemonWireRequest['flags'],
  clientPaths: Record<string, string>,
  host: HostEnvironment,
): DaemonWireRequest['flags'] {
  const requested = flags?.saveScript;
  // An empty path is a spelling to refuse, not an absent flag.
  if (requested === undefined || requested === false) return flags;
  if (req.command !== 'open') {
    throw new AppError('INVALID_ARGS', 'Remote --save-script is supported only on a fresh open.', {
      reason: 'remote_script_lifecycle_unsupported',
      hint: 'Use open --save-script. A remote close writes the recording to that path. Remote repaired-script output is not supported.',
    });
  }
  // The spelling is judged before it is expanded, and before anything asks whether it exists (ADR 0016).
  const localPath = resolveScriptDestination(
    typeof requested === 'string' ? requested : `recording-${Date.now()}.ad`,
    { cwd: req.meta?.cwd ?? host.cwd, env: host.env },
  );
  if (requested !== true && !req.flags?.force) assertScriptTargetVacant(localPath);
  clientPaths.savedScript = localPath;
  return { ...flags, saveScript: true };
}

async function prepareRemoteInstallPackage(
  req: Omit<DaemonWireRequest, 'token'>,
  info: DaemonArtifactEndpoint,
  positionals: string[],
  onProgress: UploadProgressSink | undefined,
  signal: AbortSignal,
  host: HostEnvironment,
): Promise<string | undefined> {
  const pathIndex = positionals.length === 1 ? 0 : 1;
  const rawPath = positionals[pathIndex];
  if (rawPath === undefined) return undefined;
  if (rawPath.startsWith('remote:')) {
    positionals[pathIndex] = rawPath.slice('remote:'.length);
    return undefined;
  }

  const localPath = resolveLocalInstallPath(rawPath, req.meta?.cwd, host);
  if (!localPath) return undefined;

  return await uploadArtifact({
    env: host.env,
    localPath,
    baseUrl: info.baseUrl!,
    token: info.token,
    platform: req.flags?.platform,
    leaseId: leaseScopeFromRequest(req).leaseId,
    onProgress,
    signal,
  });
}

function applyRemoteArtifactCommand(
  req: Omit<DaemonWireRequest, 'token'>,
  positionals: string[],
  flags: DaemonWireRequest['flags'] | undefined,
  clientArtifactPaths: Record<string, string>,
  host: HostEnvironment,
): DaemonWireRequest['flags'] | undefined {
  const remoteArtifact = prepareRemoteArtifactCommand(req, positionals, host);
  if (!remoteArtifact) return flags;
  if (remoteArtifact.positionalIndex !== undefined && remoteArtifact.positionalPath !== undefined) {
    positionals[remoteArtifact.positionalIndex] = remoteArtifact.positionalPath;
  }
  const nextFlags = applyRemoteArtifactFlag(
    flags,
    remoteArtifact.flagKey ?? 'out',
    remoteArtifact.flagPath,
  );
  clientArtifactPaths[remoteArtifact.field] = remoteArtifact.localPath;
  return nextFlags;
}

function applyRemoteArtifactFlag(
  flags: DaemonWireRequest['flags'] | undefined,
  flagKey: string,
  flagPath: string | undefined,
): DaemonWireRequest['flags'] | undefined {
  if (flagPath === undefined) return flags;
  return { ...(flags ?? {}), [flagKey]: flagPath };
}

function resolveLocalInstallPath(
  rawPath: string,
  cwd: string | undefined,
  host: HostEnvironment,
): string | undefined {
  const localPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd ?? host.cwd, rawPath);
  return fs.existsSync(localPath) ? localPath : undefined;
}

function createPreparedRemoteRequest(
  result: PreparedRemoteRequest & { clientArtifactPaths: Record<string, string> },
): PreparedRemoteRequest {
  return {
    positionals: result.positionals,
    flags: result.flags,
    installSource: result.installSource,
    uploadedArtifactId: result.uploadedArtifactId,
    ...(Object.keys(result.clientArtifactPaths).length > 0
      ? { clientArtifactPaths: result.clientArtifactPaths }
      : {}),
  };
}

async function prepareRemoteInstallSource(
  req: Omit<DaemonWireRequest, 'token'>,
  info: DaemonArtifactEndpoint,
  onProgress: UploadProgressSink | undefined,
  signal: AbortSignal,
  host: HostEnvironment,
): Promise<{
  installSource: NonNullable<DaemonWireRequest['meta']>['installSource'];
  uploadedArtifactId?: string;
} | null> {
  const source = req.meta?.installSource;
  if (req.command !== 'install_source' || !source || source.kind !== 'path') {
    return null;
  }

  const rawPath = source.path.trim();
  if (!rawPath) {
    return { installSource: source };
  }
  if (rawPath.startsWith('remote:')) {
    return {
      installSource: {
        ...source,
        path: rawPath.slice('remote:'.length),
      },
    };
  }

  const localPath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(req.meta?.cwd ?? host.cwd, rawPath);
  if (!fs.existsSync(localPath)) {
    return {
      installSource: {
        ...source,
        path: localPath,
      },
    };
  }

  const uploadedArtifactId = await uploadArtifact({
    env: host.env,
    localPath,
    baseUrl: info.baseUrl!,
    token: info.token,
    platform: req.flags?.platform,
    leaseId: leaseScopeFromRequest(req).leaseId,
    onProgress,
    signal,
  });
  return {
    installSource: {
      ...source,
      path: localPath,
    },
    uploadedArtifactId,
  };
}

type RemoteArtifactCommand = {
  field: string;
  localPath: string;
  positionalIndex?: number;
  positionalPath?: string;
  flagKey?: string;
  flagPath?: string;
};

function prepareRemoteArtifactCommand(
  req: Omit<DaemonWireRequest, 'token'>,
  positionals: string[],
  host: HostEnvironment,
): RemoteArtifactCommand | null {
  switch (req.command) {
    case 'screenshot':
      return prepareRemoteScreenshot(req, positionals, host);
    case 'record':
      return (positionals[0] ?? '').toLowerCase() === 'start'
        ? prepareRemoteRecording(req, host)
        : null;
    case 'perf':
    case 'trace':
      return prepareRemotePerformance(req, positionals, host);
    case 'test':
      return {
        field: 'artifactsDir',
        localPath: resolveClientArtifactOutputRoot(req, host),
        flagKey: 'artifactsDir',
        flagPath: buildRemoteTempArtifactDirPath('test-artifacts'),
      };
    default:
      return null;
  }
}

function prepareRemoteScreenshot(
  req: Omit<DaemonWireRequest, 'token'>,
  positionals: string[],
  host: HostEnvironment,
): RemoteArtifactCommand {
  const localPath = resolveClientArtifactOutputPath(req, 'path', '.png', host);
  if (positionals[0]) {
    return {
      field: 'path',
      localPath,
      positionalIndex: 0,
      positionalPath: buildRemoteTempArtifactPath('screenshot', '.png'),
    };
  }
  return {
    field: 'path',
    localPath,
    positionalIndex: 0,
    flagPath: buildRemoteTempArtifactPath('screenshot', '.png'),
  };
}

function prepareRemoteRecording(
  req: Omit<DaemonWireRequest, 'token'>,
  host: HostEnvironment,
): RemoteArtifactCommand {
  if (!recordingHasRequestedClientPath(req) && req.flags?.platform === undefined) {
    // The extension follows the session platform, which only the daemon knows: it completes
    // this destination and records to a temp path on its own host.
    return {
      field: 'outPath',
      localPath: resolveAbsoluteClientPath(`recording-${Date.now()}`, req.meta?.cwd, host),
    };
  }
  const fallbackExtension = recordingFallbackExtension(req);
  const localPath = normalizeRecordingClientArtifactPath(
    resolveClientArtifactOutputPath(req, 'outPath', fallbackExtension, host, 1),
    req,
  );
  return {
    field: 'outPath',
    localPath,
    positionalIndex: 1,
    positionalPath: buildRemoteTempArtifactPath(
      'recording',
      path.extname(localPath) || fallbackExtension,
    ),
  };
}

function prepareRemotePerformance(
  req: Omit<DaemonWireRequest, 'token'>,
  positionals: string[],
  host: HostEnvironment,
): RemoteArtifactCommand | null {
  const perfRequest =
    req.command === 'perf'
      ? parsePerfRuntimeRequest({ positionals, outPath: req.flags?.out })
      : undefined;
  const requestedPath = perfRequest
    ? 'outPath' in perfRequest
      ? perfRequest.outPath
      : undefined
    : (positionals[1] ?? req.flags?.out);
  if (!hasNonEmptyString(requestedPath)) return null;
  return {
    field: 'outPath',
    localPath: resolveAbsoluteClientPath(requestedPath, req.meta?.cwd, host),
  };
}

function resolveClientArtifactOutputRoot(
  req: Omit<DaemonWireRequest, 'token'>,
  host: HostEnvironment,
): string {
  const requested = req.flags?.artifactsDir;
  const rawPath = hasNonEmptyString(requested) ? requested : DEFAULT_TEST_ARTIFACTS_ROOT;
  return resolveAbsoluteClientPath(rawPath, req.meta?.cwd, host);
}

function recordingFallbackExtension(req: Omit<DaemonWireRequest, 'token'>): string {
  return recordingExtensionForPlatform(req.flags?.platform);
}

function recordingHasRequestedClientPath(req: Omit<DaemonWireRequest, 'token'>): boolean {
  return hasNonEmptyString(req.positionals?.[1]) || hasNonEmptyString(req.flags?.out);
}

function normalizeRecordingClientArtifactPath(
  localPath: string,
  req: Omit<DaemonWireRequest, 'token'>,
): string {
  if (req.flags?.platform !== 'web') return localPath;
  return appendRecordingExtensionWhenMissing(localPath, recordingFallbackExtension(req));
}

function resolveClientArtifactOutputPath(
  req: Omit<DaemonWireRequest, 'token'>,
  field: 'path' | 'outPath',
  fallbackExtension: string,
  host: HostEnvironment,
  positionalIndex: number = 0,
): string {
  const requested = req.positionals?.[positionalIndex] ?? req.flags?.out;
  const fallbackName = `${field === 'path' ? 'screenshot' : 'recording'}-${Date.now()}${fallbackExtension}`;
  return resolveAbsoluteClientPath(
    hasNonEmptyString(requested) ? requested : fallbackName,
    req.meta?.cwd,
    host,
  );
}

/** Shared tail of every "what local path did the caller mean" resolution in this file. */
function resolveAbsoluteClientPath(
  rawPath: string,
  cwd: string | undefined,
  host: HostEnvironment,
): string {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd ?? host.cwd, rawPath);
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A remote `open --save-script` mints its publication ID and records its caller destination before
 * it leaves (ADR 0016). The destination owner loads only for this request.
 */
export async function sendRemoteScriptOpen(
  ...args: Parameters<typeof import('./session-script-destination.ts').sendRemoteScriptOpen>
): Promise<DaemonResponse> {
  const scripts = await import('./session-script-destination.ts');
  return await scripts.sendRemoteScriptOpen(...args);
}

/**
 * Settles the batch delivery receipt a FAILED remote response names (ADR 0016, #4595): a batch that
 * stopped mid-plan still delivers what its completed steps wrote. The destination owner loads only
 * for an error that carries a receipt.
 */
export async function settleScriptDeliveryReceiptOfFailure(
  ...args: Parameters<
    typeof import('./session-script-destination.ts').settleScriptDeliveryReceiptOfFailure
  >
): Promise<
  Awaited<
    ReturnType<
      typeof import('./session-script-destination.ts').settleScriptDeliveryReceiptOfFailure
    >
  >
> {
  if (args[2].details?.scriptDeliveryReceipt === undefined) return args[2];
  const scripts = await import('./session-script-destination.ts');
  return await scripts.settleScriptDeliveryReceiptOfFailure(...args);
}

/**
 * Downloads the artifacts of a successful remote response. A session script goes only where this
 * client's own `open --save-script` recorded under `stateDir`, never where a response says; that
 * owner loads only for a response that names a publication or carries a script artifact.
 */
export async function materializeRemoteArtifacts(
  info: DaemonArtifactEndpoint,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  host: HostEnvironment,
  stateDir: string,
  signal?: AbortSignal,
): Promise<DaemonResponse> {
  if (!info.baseUrl) return response;
  const endpoint = { baseUrl: info.baseUrl, token: info.token };
  const fallbacks: RecordingDestinationWarning[] = [];
  const canceled = () =>
    createRequestCanceledError({ requestId: req.meta?.requestId }, signal?.reason);
  try {
    const download = (scripts?: SessionScriptDelivery) =>
      downloadResponseArtifacts(endpoint, req, response, { host, scripts, signal, fallbacks });
    const delivered = needsScriptDelivery(response.data)
      ? await (
          await import('./session-script-destination.ts')
        )
          .sessionScriptDelivery(endpoint, req, response, stateDir, fetchRemoteArtifact, signal)
          .settleAfter(download)
      : await download();
    if (signal?.aborted) throw canceled();
    return delivered;
  } catch (error) {
    const failure = signal?.aborted ? canceled() : error;
    throw fallbacks.length === 0 ? failure : withRecordingFallbacks(failure, fallbacks);
  }
}

function needsScriptDelivery(data: Extract<DaemonResponse, { ok: true }>['data']): boolean {
  return (
    data?.scriptPublicationId !== undefined ||
    data?.scriptDeliveryReceipt !== undefined ||
    (Array.isArray(data?.artifacts) && data.artifacts.some(isSessionScriptArtifact))
  );
}

async function downloadResponseArtifacts(
  endpoint: Required<DaemonArtifactEndpoint>,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  client: Readonly<{
    host: HostEnvironment;
    scripts: SessionScriptDelivery | undefined;
    signal: AbortSignal | undefined;
    fallbacks: RecordingDestinationWarning[];
  }>,
): Promise<DaemonResponse> {
  if (recordAction(req) === 'stop') return await deliverRecordStop(endpoint, req, response, client);
  const artifacts = Array.isArray(response.data?.artifacts) ? response.data.artifacts : [];
  const data = withoutClientOwnedFields(response.data);
  if (artifacts.length === 0) return data === response.data ? response : { ok: true, data };
  const nextData: Record<string, unknown> = { ...(data ?? {}) };
  const nextArtifacts: DaemonArtifact[] = [];
  const { host, scripts, signal } = client;
  for (const artifact of artifacts) {
    if (isSessionScriptArtifact(artifact)) {
      await scripts?.publish(artifact, nextData, nextArtifacts);
      continue;
    }
    if (!hasDownloadableArtifactId(artifact)) {
      // Nothing was written for it here, so it names no local path.
      nextArtifacts.push(withoutPeerLocalPath(artifact) as DaemonArtifact);
      continue;
    }
    if (!isDownloadableField(artifact.field)) continue;
    const destination = resolveMaterializedArtifactPath(artifact, req, host);
    const materializedPath = await downloadRemoteArtifact({
      ...endpoint,
      artifactId: artifact.artifactId,
      destinationPath: destination.path,
      requestScope: req.meta,
      signal,
      mode: artifact.artifactType === 'test-artifacts' ? 'directory' : 'file',
    });
    // Directory downloads publish one entry under the requested root.
    nextData[artifact.field] = materializedPath;
    nextArtifacts.push({ ...artifact, localPath: materializedPath });
  }
  nextData.artifacts = nextArtifacts;
  return { ok: true, data: nextData };
}

async function deliverRecordStop(
  endpoint: Required<DaemonArtifactEndpoint>,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  client: Readonly<{
    host: HostEnvironment;
    scripts: SessionScriptDelivery | undefined;
    signal: AbortSignal | undefined;
    fallbacks: RecordingDestinationWarning[];
  }>,
): Promise<DaemonResponse> {
  const answer = await import('./record-stop-answer.ts');
  const plan = answer.planRecordingDownloads(
    response.data,
    (id) => new URL(buildDaemonArtifactUrl(endpoint.baseUrl, id)),
    {
      recording: (artifact) => resolveMaterializedArtifactPath(artifact, req, client.host),
      script: (artifact) => client.scripts?.plannedDestination(artifact),
    },
  );
  const local: Record<string, unknown> = {};
  const delivered: DaemonArtifact[] = [];
  const { downloadRemoteArtifactFromUrl } = await import('./artifact-download.ts');
  for (const entry of plan.deliveries) {
    if (entry.kind === 'script') {
      await client.scripts?.publish(entry.artifact, local, delivered);
      continue;
    }
    const { artifact, destination, url } = entry;
    const written = await downloadRemoteArtifactFromUrl({
      token: endpoint.token,
      artifactUrl: url,
      artifactId: artifact.artifactId,
      destinationPath: destination.path,
      requestScope: req.meta,
      signal: client.signal,
      // A recording is one staged file; a cwd fallback never replaces an existing file.
      mode: destination.fallback ? 'staged-new-file' : 'staged-file',
    });
    if (destination.fallback) {
      client.fallbacks.push({
        reason: 'recording_destination_not_requested',
        field: artifact.field,
        path: written,
      });
    }
    delivered.push({ ...artifact, localPath: written });
  }
  if (client.fallbacks.length)
    Object.assign(local, recordingFallbackDetails(local, client.fallbacks));
  return {
    ok: true,
    data: answer.projectRecordStopResult(response.data, local, delivered, plan.missingRole),
  };
}

export async function projectRemoteErrorDetails(
  req: DaemonWireRequest,
  details: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (recordAction(req) !== 'stop') return withoutClientOwnedFields(details);
  const answer = await import('./record-stop-answer.ts');
  return answer.projectRecordStopErrorDetails(details);
}

function recordAction(req: DaemonWireRequest): string | undefined {
  return req.command === 'record' ? req.positionals?.[0]?.toLowerCase() : undefined;
}

type RecordingDestinationWarning = Readonly<{
  reason: 'recording_destination_not_requested';
  field: string;
  path: string;
}>;

function fallbackWarningText({ field, path: written }: RecordingDestinationWarning): string {
  return `The remote recording ${field} was saved to ${written} in the current directory, because the request named no destination for it.`;
}

function withRecordingFallbacks(
  error: unknown,
  fallbacks: RecordingDestinationWarning[],
): AppError {
  const failure = asAppError(error);
  return new AppError(
    failure.code,
    failure.message,
    {
      ...failure.details,
      ...recordingFallbackDetails(failure.details, fallbacks),
    },
    failure.cause,
  );
}

function recordingFallbackDetails(
  data: Record<string, unknown> | undefined,
  fallbacks: RecordingDestinationWarning[],
) {
  const warnings = Array.isArray(data?.warnings) ? data.warnings : [];
  return {
    recordingDestinationWarnings: fallbacks,
    warnings: [...warnings, ...fallbacks.map(fallbackWarningText)],
  };
}

function hasDownloadableArtifactId(
  artifact: DaemonArtifact | undefined,
): artifact is DaemonArtifact & { artifactId: string } {
  return (
    artifact !== undefined &&
    artifact !== null &&
    typeof artifact === 'object' &&
    typeof artifact.artifactId === 'string'
  );
}

function isSessionScriptArtifact(artifact: DaemonArtifact | undefined): boolean {
  return artifact?.field === 'savedScript' || artifact?.artifactType === 'session-script';
}

function isDownloadableField(field: unknown): field is string {
  return (
    typeof field === 'string' &&
    ![
      'artifacts',
      'savedScript',
      'scriptDeliveryFailure',
      'recordingDestinationWarnings',
      'recordingArtifactWarning',
      'warnings',
    ].includes(field)
  );
}

function withoutClientOwnedFields<T extends Record<string, unknown> | undefined>(data: T): T {
  if (data === undefined) return data;
  const {
    savedScript: _script,
    recordingDestinationWarnings: _warnings,
    recordingArtifactWarning: _artifactWarning,
    ...kept
  }: Record<string, unknown> = data;
  if (Array.isArray(kept.artifacts)) kept.artifacts = kept.artifacts.map(withoutPeerLocalPath);
  return kept as T;
}

function withoutPeerLocalPath(artifact: unknown): unknown {
  if (typeof artifact !== 'object' || artifact === null || !('localPath' in artifact)) {
    return artifact;
  }
  const { localPath: _peerPath, ...kept } = artifact as Record<string, unknown>;
  return kept;
}

/**
 * Whether this request finishes a trace or perf capture whose destination this client named in an
 * EARLIER request. The daemon echoes that destination as `localPath`. A record stop never accepts
 * a `localPath` (#4518). The finishing actions mirror the daemon's own (`request-finalization.ts`).
 */
function finishesEarlierClientCapture(req: DaemonWireRequest): boolean {
  const [first, second, third] = (req.positionals ?? []).map((value) => value.toLowerCase());
  switch (req.command) {
    case 'trace':
      return first === 'stop';
    case 'perf':
      return third === 'stop' || third === 'report' || (first === 'trace' && second === 'stop');
    default:
      return false;
  }
}

/**
 * Where this client writes one downloaded artifact. The client chooses: a path it registered in
 * this request wins, and a response `localPath` is accepted only on a trace or perf stop or report
 * that echoes an earlier request's destination. Anything else, including every record artifact
 * the request named no path for, lands in cwd under the response file name's basename.
 */
function resolveMaterializedArtifactPath(
  artifact: DaemonArtifact,
  req: DaemonWireRequest,
  host: HostEnvironment,
): { path: string; fallback: boolean } {
  const requestedPath = req.meta?.clientArtifactPaths?.[artifact.field];
  if (hasNonEmptyString(requestedPath)) return { path: requestedPath, fallback: false };
  if (hasNonEmptyString(artifact.localPath) && finishesEarlierClientCapture(req)) {
    return { path: artifact.localPath, fallback: false };
  }
  const cwd = path.resolve(req.meta?.cwd ?? host.cwd);
  const fileName =
    localFileName(artifact.fileName) ??
    localFileName(`${artifact.field}-${Date.now()}`) ??
    `artifact-${Date.now()}`;
  return { path: path.join(cwd, fileName), fallback: true };
}

/**
 * The last component of a peer-named file as ONE ordinary entry name under both POSIX and Windows
 * rules, or `undefined`, so the name cannot leave or switch the directory it is joined to.
 */
function localFileName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().split(/[\\/]/).pop() ?? '';
  return isOrdinaryEntryName(name, path.posix) && isOrdinaryEntryName(name, path.win32)
    ? name
    : undefined;
}

type DownloadRemoteArtifactParams = {
  baseUrl: string;
  token: string;
  artifactId: string;
  destinationPath: string;
  requestScope: DaemonWireRequest['meta'];
  timeoutMs?: number;
  /** How the download lands (`artifact-download.ts`); defaults to one file written in place. */
  mode?: RemoteArtifactDestinationMode;
  /** The caller's cancellation (`artifact-download.ts`). */
  signal?: AbortSignal;
};

export async function downloadRemoteArtifact(
  params: DownloadRemoteArtifactParams,
): Promise<string> {
  // Remote artifact transfer is not part of routine CLI startup. Keep the HTTP/archive owner out
  // of the eager command graph and load it only after a remote response names an artifact.
  const { downloadRemoteArtifactFromUrl } = await import('./artifact-download.ts');
  const { baseUrl, ...download } = params;
  return await downloadRemoteArtifactFromUrl({
    ...download,
    artifactUrl: new URL(buildDaemonArtifactUrl(baseUrl, params.artifactId)),
  });
}

type FetchRemoteArtifactParams = {
  baseUrl: string;
  token: string;
  artifactId: string;
  requestScope: DaemonWireRequest['meta'];
  /** The fetch stops once the body crosses this size. */
  maxBytes: number;
  /** The caller's cancellation (`artifact-download.ts`). */
  signal?: AbortSignal;
};

/** Fetches one artifact into memory, capped at `maxBytes` (`artifact-download.ts`). */
export async function fetchRemoteArtifact(params: FetchRemoteArtifactParams): Promise<Buffer> {
  const { fetchRemoteArtifactFromUrl } = await import('./artifact-download.ts');
  const { baseUrl, ...fetch } = params;
  return await fetchRemoteArtifactFromUrl({
    ...fetch,
    artifactUrl: new URL(buildDaemonArtifactUrl(baseUrl, params.artifactId)),
  });
}

function buildDaemonArtifactUrl(baseUrl: string, artifactId: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(`artifacts/${encodeURIComponent(artifactId)}`, normalizedBase).toString();
}

function isRemoteDaemon(info: DaemonArtifactEndpoint): boolean {
  return typeof info.baseUrl === 'string' && info.baseUrl.length > 0;
}
