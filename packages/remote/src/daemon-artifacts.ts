import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { RequestProgressSink } from '@agent-device/contracts/progress';
import type {
  DaemonArtifact,
  DaemonResponse,
  DaemonResponseData,
} from '@agent-device/kernel/contracts';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildRemoteTempArtifactDirPath,
  buildRemoteTempArtifactPath,
} from '@agent-device/contracts/daemon-http';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import { assertScriptTargetVacant, resolveScriptDestination } from '@agent-device/host-kit/file';
import { leaseScopeFromRequest } from '@agent-device/contracts/lease-scope';
import {
  appendRecordingExtensionWhenMissing,
  recordingExtensionForPlatform,
} from '@agent-device/capture-kit/recording-output-path';
import { parsePerfRuntimeRequest } from '@agent-device/capture-kit/perf-runtime-plan';
import type { RemoteArtifactRequest } from './artifact-download.ts';
import type { SessionScriptDelivery } from './session-script-destination.ts';
import { uploadArtifact } from './upload-client.ts';
import { withUploadPreparationDeadline, type UploadHandoff } from './upload-stream.ts';
import { createStderrUploadProgressReporter, type UploadProgressSink } from './upload-progress.ts';

// Mirrors `DEFAULT_TEST_ARTIFACTS_ROOT` in `packages/replay-test/src/internal/session-test-artifacts.ts`
// (the daemon's own default). Duplicated rather than imported: pulling it from
// `@agent-device/contracts` grew that package's pinned eager-import closure by 3 modules for one
// string (#2246) — not worth it for a literal that only ever changes alongside this comment.
const DEFAULT_TEST_ARTIFACTS_ROOT = '.agent-device/test-artifacts';

export type DaemonArtifactEndpoint = {
  baseUrl?: string;
  token: string;
  downloadHandoff?: RemoteArtifactRequest['downloadHandoff'];
};

export type RemoteDaemonArtifactEndpoint = DaemonArtifactEndpoint & { baseUrl: string };

type UploadEndpoint = DaemonArtifactEndpoint & { uploadHandoff?: UploadHandoff };

export type PreparedRemoteRequest = {
  positionals: string[];
  flags?: DaemonWireRequest['flags'];
  installSource?: NonNullable<DaemonWireRequest['meta']>['installSource'];
  uploadedArtifactId?: string;
  clientArtifactPaths?: Record<string, string>;
};

export async function prepareRemoteRequestArtifacts(
  req: Omit<DaemonWireRequest, 'token'>,
  info: UploadEndpoint,
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
  info: UploadEndpoint,
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

/** Why a remote request's script answer is refused. */
const REMOTE_SCRIPT_OUTPUT_REASONS = {
  // `--save-script` was asked for on a command whose script lifecycle the daemon does not remote.
  lifecycleUnsupported: { reason: 'remote_script_lifecycle_unsupported' },
} as const satisfies ReasonTable<'remote transfer'>;

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
      reason: REMOTE_SCRIPT_OUTPUT_REASONS.lifecycleUnsupported.reason,
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
  info: UploadEndpoint,
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
    handoff: info.uploadHandoff,
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
  info: UploadEndpoint,
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
    handoff: info.uploadHandoff,
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
): Promise<DaemonResponse> {
  if (!info.baseUrl) return response;
  const endpoint = { ...info, baseUrl: info.baseUrl };
  const artifacts = Array.isArray(response.data?.artifacts) ? response.data.artifacts : [];
  const download = (scripts?: SessionScriptDelivery) =>
    downloadResponseArtifacts(endpoint, req, response, host, scripts);
  // A receipt is a delivery instruction of its own: a batch answer may carry one while naming no
  // publication and no script artifact of its own (#4595).
  if (
    response.data?.scriptPublicationId === undefined &&
    response.data?.scriptDeliveryReceipt === undefined &&
    !artifacts.some(isSessionScriptArtifact)
  ) {
    return await download();
  }
  const { sessionScriptDelivery } = await import('./session-script-destination.ts');
  const scripts = sessionScriptDelivery(endpoint, req, response, stateDir, fetchRemoteArtifact);
  return await scripts.settleAfter(download);
}

async function downloadResponseArtifacts(
  endpoint: RemoteDaemonArtifactEndpoint,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  host: HostEnvironment,
  scripts: SessionScriptDelivery | undefined,
): Promise<DaemonResponse> {
  const artifacts = Array.isArray(response.data?.artifacts) ? response.data.artifacts : [];
  const data = withoutScriptFieldOwner(response.data);
  if (artifacts.length === 0) return data === response.data ? response : { ok: true, data };
  const nextData: Record<string, unknown> = { ...(data ?? {}) };
  const nextArtifacts: DaemonArtifact[] = [];
  const recording = isRecordStop(req) ? recordingDelivery() : undefined;
  const dropped: DroppedArtifact[] = [];
  const delivery = { nextData, nextArtifacts, recording, dropped };
  for (const artifact of artifacts) {
    if (isSessionScriptArtifact(artifact)) {
      await scripts?.publish(artifact, nextData, nextArtifacts);
      continue;
    }
    if (!hasDownloadableArtifactId(artifact)) {
      nextArtifacts.push(artifact);
      continue;
    }
    await downloadOneArtifact(endpoint, req, host, artifact, delivery);
  }
  nextData.artifacts = nextArtifacts;
  recording?.report(nextData);
  if (dropped.length > 0) discloseDroppedArtifacts(nextData, dropped);
  return { ok: true, data: nextData };
}

async function downloadOneArtifact(
  endpoint: RemoteDaemonArtifactEndpoint,
  req: DaemonWireRequest,
  host: HostEnvironment,
  artifact: DaemonArtifact & { artifactId: string },
  {
    nextData,
    nextArtifacts,
    recording,
    dropped,
  }: {
    nextData: Record<string, unknown>;
    nextArtifacts: DaemonArtifact[];
    recording: { add(field: string, written: string, fallback: boolean): void } | undefined;
    dropped: DroppedArtifact[];
  },
): Promise<void> {
  if (typeof artifact.field !== 'string' || isClientOwnedResponseField(artifact.field)) return;
  const destination = resolveMaterializedArtifactPath(artifact, req, host);
  if (!destination || destination.path.includes('\0')) {
    dropped.push({ field: artifact.field, reason: 'artifact_name_invalid' });
    return;
  }
  const materializedPath = await downloadRemoteArtifact({
    ...endpoint,
    artifactId: artifact.artifactId,
    destinationPath: destination.path,
    requestScope: req.meta,
    // #2246: `test-artifacts` is the one directory-shaped artifact type today — known from the
    // response, before any bytes arrive, so cleanup-on-error can be decided up front instead of
    // racing the response headers (a directory destination must never be `rm`'d wholesale; see
    // `downloadRemoteArtifact`).
    isDirectory: recording === undefined && artifact.artifactType === 'test-artifacts',
    stagedFile: recording !== undefined,
  });
  recording?.add(artifact.field, materializedPath, destination.fallback);
  // Directory artifacts download into a caller-owned root, then atomically publish their one
  // top-level entry beneath it. Use the path the download actually published rather than the
  // root hint sent over the wire; otherwise `artifactsDir` loses its suite invocation segment.
  nextData[artifact.field] = materializedPath;
  nextArtifacts.push({
    ...artifact,
    localPath: materializedPath,
  });
}

const RECORDING_DESTINATION_REASONS = {
  // A remote recording was saved to the current directory because the request named no destination;
  // a warning.
  notRequested: { reason: 'recording_destination_not_requested' },
} as const satisfies ReasonTable<'record'>;

type RecordingDestinationWarning = {
  reason: typeof RECORDING_DESTINATION_REASONS.notRequested.reason;
  field: string;
  path: string;
};

function recordingDelivery() {
  const destinationWarnings: RecordingDestinationWarning[] = [];
  const recordingPaths: string[] = [];
  return {
    add(field: string, written: string, fallback: boolean): void {
      if (fallback) {
        destinationWarnings.push({
          reason: RECORDING_DESTINATION_REASONS.notRequested.reason,
          field,
          path: written,
        });
      }
      if (field === 'outPath' || field === 'chunkPath') recordingPaths.push(written);
    },
    report(data: Record<string, unknown>): void {
      if (destinationWarnings.length > 0) {
        data.recordingDestinationWarnings = destinationWarnings;
        data.warnings = [
          ...(Array.isArray(data.warnings) ? data.warnings : []),
          ...destinationWarnings.map(
            ({ path: written }) =>
              `Saved remote recording file to ${written} in the current directory because this request named no destination.`,
          ),
        ];
      }
      // The daemon lists the first video and subsequent chunk artifacts in chunk order.
      if (Array.isArray(data.chunks) && recordingPaths.length === data.chunks.length) {
        data.chunks = data.chunks.map((chunk, index) => ({
          ...chunk,
          path: recordingPaths[index],
        }));
      }
    },
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

function isClientOwnedResponseField(field: string): boolean {
  return (
    field === 'artifacts' ||
    field === 'savedScript' ||
    field === 'scriptDeliveryFailure' ||
    field === 'droppedArtifacts' ||
    field === 'warnings'
  );
}

/** A response artifact the client did not download, and why. */
type DroppedArtifact = { field: string; reason: 'artifact_name_invalid' };

/**
 * Adds the artifacts this client dropped, and one warning for each, to a response body. The action
 * keeps its own outcome; only the dropped artifacts are missing from `artifacts`.
 */
function discloseDroppedArtifacts(data: Record<string, unknown>, dropped: DroppedArtifact[]): void {
  data.droppedArtifacts = dropped;
  data.warnings = [
    ...(Array.isArray(data.warnings) ? data.warnings : []),
    ...dropped.map(
      ({ field }) =>
        `The remote artifact for ${JSON.stringify(field)} was not downloaded: its name cannot be a file name.`,
    ),
  ];
}

// Only a successfully published version can name a caller's savedScript destination.
function withoutScriptFieldOwner(
  data: DaemonResponseData | undefined,
): DaemonResponseData | undefined {
  if (data === undefined || !('savedScript' in data)) return data;
  const { savedScript: _peerValue, ...kept } = data;
  return kept;
}

/**
 * Whether this request finishes a trace or perf capture whose destination the daemon echoes
 * from an earlier request. The finishing actions mirror `request-finalization.ts`.
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

function isRecordStop(req: DaemonWireRequest): boolean {
  return req.command === 'record' && req.positionals?.[0]?.toLowerCase() === 'stop';
}

/**
 * A path from this request wins. A record stop without one can use only a plain name in cwd.
 * Trace and perf stop or report can still use an echoed destination from an earlier request.
 * A NUL in a response file name cannot provide a fallback destination.
 */
function resolveMaterializedArtifactPath(
  artifact: DaemonArtifact,
  req: DaemonWireRequest,
  host: HostEnvironment,
): { path: string; fallback: boolean } | undefined {
  const requestedPath = req.meta?.clientArtifactPaths?.[artifact.field];
  if (hasNonEmptyString(requestedPath)) return { path: requestedPath, fallback: false };
  if (isRecordStop(req)) {
    const requested = artifact.field === 'outPath' ? req.positionals[1] : undefined;
    if (hasNonEmptyString(requested)) {
      return { path: resolveAbsoluteClientPath(requested, req.meta?.cwd, host), fallback: false };
    }
    if (typeof artifact.fileName === 'string' && artifact.fileName.includes('\0')) return undefined;
    const fileName = localFileName(artifact.fileName) ?? `recording-${crypto.randomUUID()}`;
    return { path: path.resolve(req.meta?.cwd ?? host.cwd, fileName), fallback: true };
  }
  if (hasNonEmptyString(artifact.localPath) && finishesEarlierClientCapture(req)) {
    return { path: artifact.localPath, fallback: false };
  }
  const fallbackPath = resolveOrdinaryArtifactFallbackPath(artifact, req.meta?.cwd ?? host.cwd);
  return fallbackPath ? { path: fallbackPath, fallback: false } : undefined;
}

function resolveOrdinaryArtifactFallbackPath(
  artifact: DaemonArtifact,
  cwd: string,
): string | undefined {
  const { fileName: rawName = '' }: { fileName?: unknown } = artifact;
  if (typeof rawName !== 'string' || rawName.includes('\0')) return undefined;
  const pathRules = process.platform === 'win32' ? path.win32 : path.posix;
  const responseName = pathRules.basename(rawName.trim());
  const fileName =
    responseName && responseName !== '.' && responseName !== '..'
      ? responseName
      : `${pathRules.basename(artifact.field)}-${Date.now()}`;
  if (pathRules === path.win32 && /^[a-z]:/i.test(fileName)) return undefined;
  return pathRules.resolve(cwd, fileName);
}

function localFileName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value) > 255) return;
  if (/[<>:"/\\|?*\p{Cc}\p{Surrogate}]/u.test(value) || /[. ]$/.test(value)) return;
  const stem = value.split('.')[0]?.trimEnd() ?? '';
  if (/^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)$/i.test(stem)) return;
  return value;
}

type DownloadRemoteArtifactParams = {
  baseUrl: string;
  token: string;
  artifactId: string;
  destinationPath: string;
  requestScope: DaemonWireRequest['meta'];
  downloadHandoff?: DaemonArtifactEndpoint['downloadHandoff'];
  timeoutMs?: number;
  /** Whether `destinationPath` is a caller-owned root rather than one file to create. */
  isDirectory?: boolean;
  stagedFile?: boolean;
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
  downloadHandoff?: DaemonArtifactEndpoint['downloadHandoff'];
  /** The fetch stops once the body crosses this size. */
  maxBytes: number;
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
