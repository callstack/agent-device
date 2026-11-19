import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type {
  DaemonArtifact,
  DaemonResponse,
  DaemonResponseData,
} from '@agent-device/kernel/contracts';
import type { CaptureGrant } from './capture-grant.ts';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildRemoteTempArtifactDirPath,
  buildRemoteTempArtifactPath,
} from '@agent-device/contracts/daemon-http';
import { AppError } from '@agent-device/kernel/errors';
import { resolveUserPath } from '@agent-device/host-kit/file';
import { leaseScopeFromRequest } from '@agent-device/contracts/lease-scope';
import {
  appendRecordingExtensionWhenMissing,
  recordingExtensionForPlatform,
} from '@agent-device/capture-kit/recording-output-path';
import { parsePerfRuntimeRequest } from '@agent-device/capture-kit/perf-runtime-plan';
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
): Promise<PreparedRemoteRequest> {
  if (!isRemoteDaemon(info)) {
    return await prepareRemoteRequestArtifactsWithinBudget(req, info, signal, host);
  }
  return await withUploadPreparationDeadline(
    signal,
    async (preparationSignal) =>
      await prepareRemoteRequestArtifactsWithinBudget(req, info, preparationSignal, host),
  );
}

async function prepareRemoteRequestArtifactsWithinBudget(
  req: Omit<DaemonWireRequest, 'token'>,
  info: DaemonArtifactEndpoint,
  signal: AbortSignal,
  host: HostEnvironment,
): Promise<PreparedRemoteRequest> {
  const positionals = [...(req.positionals ?? [])];
  let flags = req.flags ? { ...req.flags } : undefined;
  let installSource = req.meta?.installSource;
  const clientArtifactPaths: Record<string, string> = {};
  let uploadedArtifactId: string | undefined;
  const uploadProgress = createStderrUploadProgressReporter(host.env);

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
  if (!requested) return flags;
  if (req.command !== 'open') {
    throw new AppError('INVALID_ARGS', 'Remote --save-script is supported only on a fresh open.', {
      reason: 'remote_script_lifecycle_unsupported',
      hint: 'Use open --save-script. A remote close writes the recording to that path. Remote repaired-script output is not supported.',
    });
  }
  const localPath = resolveUserPath(
    typeof requested === 'string' ? requested : `recording-${Date.now()}.ad`,
    { cwd: req.meta?.cwd ?? host.cwd, env: host.env },
  );
  if (requested !== true && !req.flags?.force && fs.existsSync(localPath)) {
    throw new AppError('COMMAND_FAILED', `A file already exists at ${localPath}.`, {
      reason: 'script_target_exists',
      path: localPath,
      hint: 'Choose another output path or pass --force/--overwrite.',
    });
  }
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

/**
 * #4518: a capture start's caller-named destination is admitted and durably stored under its own
 * minted grant ID BEFORE the request is dispatched — never created from the response — so an
 * accepted-but-answerless start still retains its matching authority in a later CLI process.
 * Returns the grant ID the transport should carry in `meta.captureGrantId`, or `undefined`.
 */
export async function admitCaptureStartGrant(
  req: DaemonWireRequest,
  info: DaemonArtifactEndpoint,
  stateDir: string,
): Promise<string | undefined> {
  if (!info.baseUrl || req.command !== 'record') return undefined;
  const destination = req.meta?.clientArtifactPaths?.outPath;
  if (!hasNonEmptyString(destination)) return undefined;
  const grants = await import('./capture-grant.ts');
  if (!grants.isCaptureStartRequest(req)) return undefined;
  return await grants.admitCaptureGrant({
    stateDir,
    baseUrl: info.baseUrl,
    req,
    slot: 'record',
    destination,
  });
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
 * Releases the grant for a start known to have failed before execution. The request's own
 * grant ID and scope identify the only record eligible for removal. Never throws.
 */
export async function noteFailedCaptureStart(
  info: DaemonArtifactEndpoint,
  req: DaemonWireRequest,
  stateDir: string,
): Promise<void> {
  try {
    if (!info.baseUrl || !req.meta?.captureGrantId) return;
    const grants = await import('./capture-grant.ts');
    const slot = grants.captureSlotOfCommand(req.command);
    if (slot === undefined || !grants.isCaptureStartRequest(req)) return;
    await grants.releaseCaptureGrant({
      stateDir,
      baseUrl: info.baseUrl,
      req,
      slot,
      grantId: req.meta?.captureGrantId,
    });
  } catch {
    // A release that cannot run leaves the record; the store's sweep still bounds it.
  }
}

/**
 * Retires the capture grants of a close's own authenticated scope: a close the daemon confirmed
 * ends the session's captures (including a recording its teardown retained), so their grants
 * must not outlive the session. Only the close's scope is matched; another scope's grants are
 * never touched. Never throws, so it never replaces the close's own outcome.
 */
export async function retireClosedScopeCaptureGrants(
  info: DaemonArtifactEndpoint,
  req: DaemonWireRequest,
  stateDir: string,
): Promise<void> {
  try {
    if (!info.baseUrl || req.command !== 'close') return;
    const grants = await import('./capture-grant.ts');
    await grants.retireCaptureGrantsInScope({ stateDir, baseUrl: info.baseUrl, req });
  } catch {
    // A retire that cannot run leaves the records; the store's sweep still bounds them.
  }
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
  try {
    const endpoint = { baseUrl: info.baseUrl, token: info.token };
    const artifacts = Array.isArray(response.data?.artifacts) ? response.data.artifacts : [];
    const download = (scripts?: SessionScriptDelivery) =>
      downloadResponseArtifacts(endpoint, req, response, host, scripts, stateDir);
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
    const scripts = sessionScriptDelivery(
      endpoint,
      req,
      response,
      stateDir,
      downloadRemoteArtifact,
    );
    return await scripts.settleAfter(download);
  } finally {
    // A close the daemon confirmed ends its scope's captures without a stop echo (a recording its
    // teardown retained, a daemon restart, a lost start answer), so the close retires the grants
    // of its own authenticated scope even when bringing the response's artifacts here failed.
    await retireClosedScopeCaptureGrants(info, req, stateDir);
  }
}

async function downloadResponseArtifacts(
  endpoint: Required<DaemonArtifactEndpoint>,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  host: HostEnvironment,
  scripts: SessionScriptDelivery | undefined,
  stateDir: string,
): Promise<DaemonResponse> {
  const artifacts = Array.isArray(response.data?.artifacts) ? response.data.artifacts : [];
  const data = withoutScriptFieldOwner(response.data);
  const grantContext = await resolveCaptureGrantContext(endpoint, req, response, stateDir);
  // A matched echo whose delivery then fails keeps its grant: the daemon answered, so a retried
  // stop can still deliver to the granted destination. Only a successful delivery releases the
  // grant — including a matching echo that carried no artifacts at all.
  const delivered = await downloadAllArtifacts(
    endpoint,
    req,
    response,
    host,
    scripts,
    grantContext,
    data,
    artifacts,
  );
  if (grantContext?.grant !== undefined) {
    const grants = await import('./capture-grant.ts');
    await grants.releaseCaptureGrant({
      stateDir,
      baseUrl: endpoint.baseUrl,
      req,
      slot: grantContext.slot,
      grantId: grantContext.echoedGrantId,
    });
  }
  return delivered;
}

async function downloadAllArtifacts(
  endpoint: Required<DaemonArtifactEndpoint>,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  host: HostEnvironment,
  scripts: SessionScriptDelivery | undefined,
  grantContext: CaptureGrantContext | undefined,
  data: DaemonResponseData | undefined,
  artifacts: DaemonArtifact[],
): Promise<DaemonResponse> {
  if (artifacts.length === 0) return data === response.data ? response : { ok: true, data };
  const nextData: Record<string, unknown> = { ...(data ?? {}) };
  const nextArtifacts: DaemonArtifact[] = [];
  for (const artifact of artifacts) {
    if (isSessionScriptArtifact(artifact)) {
      await scripts?.publish(artifact, nextData, nextArtifacts);
      continue;
    }
    if (!hasDownloadableArtifactId(artifact)) {
      nextArtifacts.push(artifact);
      continue;
    }
    if (typeof artifact.field !== 'string' || isClientOwnedResponseField(artifact.field)) continue;
    const downloadPath = resolveMaterializedArtifactPath(artifact, req, host, grantContext);
    const materializedPath = await downloadRemoteArtifact({
      ...endpoint,
      artifactId: artifact.artifactId,
      destinationPath: downloadPath,
      requestScope: req.meta,
      // #2246: `test-artifacts` is the one directory-shaped artifact type today — known from the
      // response, before any bytes arrive, so cleanup-on-error can be decided up front instead of
      // racing the response headers (a directory destination must never be `rm`'d wholesale; see
      // `downloadRemoteArtifact`).
      isDirectory: artifact.artifactType === 'test-artifacts',
    });
    // Directory artifacts download into a caller-owned root, then atomically publish their one
    // top-level entry beneath it. Use the path the download actually published rather than the
    // root hint sent over the wire; otherwise `artifactsDir` loses its suite invocation segment.
    nextData[artifact.field] = materializedPath;
    nextArtifacts.push({
      ...artifact,
      localPath: materializedPath,
    });
  }
  nextData.artifacts = nextArtifacts;
  return { ok: true, data: nextData };
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
    field === 'warnings'
  );
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
 * Whether this request finishes a capture whose destination this client named in an EARLIER
 * request (`record start`, a perf or trace start with an output path). The daemon echoes that
 * destination, and the paths it derives from it, as `localPath`, because this process kept no
 * record of it. The finishing actions mirror the daemon's own (`request-finalization.ts`).
 */
function finishesEarlierClientCapture(req: DaemonWireRequest): boolean {
  const [first, second, third] = (req.positionals ?? []).map((value) => value.toLowerCase());
  switch (req.command) {
    case 'record':
    case 'trace':
      return first === 'stop';
    case 'perf':
      return third === 'stop' || third === 'report' || (first === 'trace' && second === 'stop');
    default:
      return false;
  }
}

/**
 * #4518: the grant context one finishing response is matched against. A persisted start
 * destination is authorized EXCLUSIVELY by the daemon's PRODUCER-ECHOED `captureGrantId`
 * (response data or artifact) matched against the grant this client minted and persisted BEFORE
 * dispatch, with the full scope (endpoint/tenant/run/lease/session/slot). An older daemon that
 * echoes no ID, or an echoed ID that matches nothing, authorizes NOTHING: only the current
 * request's own registered paths win, and everything else keeps the pre-grant contained cwd-local
 * name with a disclosed diagnostic — there is no scope-open fallback and no generation is inferred
 * from an unbound response. `undefined` for requests that finish no grant-covered capture
 * (trace/perf remain on the existing echo path — residual #4518).
 */
type CaptureGrantContext = Readonly<{
  slot: 'record';
  grant: CaptureGrant | undefined;
  echoedGrantId: string | undefined;
  authorize(params: { field: string; localPath: unknown }): string | undefined;
  disclose(
    field: string,
    detail: 'missing-grant' | 'unmatched-grant-id' | 'not-a-derivation',
  ): void;
}>;

async function resolveCaptureGrantContext(
  endpoint: Required<DaemonArtifactEndpoint>,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  stateDir: string,
): Promise<CaptureGrantContext | undefined> {
  if (req.command !== 'record') return undefined;
  const grants = await import('./capture-grant.ts');
  if (!grants.finishesCaptureRequest(req)) return undefined;
  const slot = 'record';
  const artifacts = Array.isArray(response.data?.artifacts) ? response.data.artifacts : [];
  const echoedGrantId =
    grants.readCaptureGrantId(response.data?.captureGrantId) ??
    artifacts
      .map((artifact) => grants.readCaptureGrantId(artifact?.captureGrantId))
      .find((id) => id !== undefined);
  const grant = grants.readCaptureGrantById({
    stateDir,
    baseUrl: endpoint.baseUrl,
    req,
    slot,
    grantId: echoedGrantId,
  });
  // A matched echo alone settles nothing yet: the caller releases the grant only after this
  // response's delivery succeeded, so a failed materialization leaves the grant for a retry.
  return {
    slot,
    grant,
    echoedGrantId,
    authorize: ({ field, localPath }) =>
      grants.authorizedCaptureLocalPath({ grant, field, localPath }),
    disclose: (field, detail) => grants.discloseUnauthorizedLocalPath(req, field, detail),
  };
}

/**
 * Where this client writes one downloaded artifact. The client chooses: a path it registered in
 * this request wins; otherwise a finishing capture's response `localPath` is accepted only when it
 * is an allowlisted derivation of the destination this client granted for that capture (#4518).
 * Anything else lands in cwd under the response file name's basename, and the refusal is
 * disclosed — a response string never chooses the directory.
 */
function resolveMaterializedArtifactPath(
  artifact: DaemonArtifact,
  req: DaemonWireRequest,
  host: HostEnvironment,
  grantContext: CaptureGrantContext | undefined,
): string {
  const requestedPath = req.meta?.clientArtifactPaths?.[artifact.field];
  if (hasNonEmptyString(requestedPath)) return requestedPath;
  if (grantContext !== undefined) {
    const authorized = grantContext.authorize({
      field: artifact.field,
      localPath: artifact.localPath,
    });
    if (authorized !== undefined) return authorized;
    grantContext.disclose(
      artifact.field,
      grantContext.grant === undefined
        ? grantContext.echoedGrantId === undefined
          ? 'missing-grant'
          : 'unmatched-grant-id'
        : 'not-a-derivation',
    );
  } else if (hasNonEmptyString(artifact.localPath) && finishesEarlierClientCapture(req)) {
    return artifact.localPath;
  }
  const responseName = path.basename(artifact.fileName?.trim() ?? '');
  const fileName =
    responseName && responseName !== '.' && responseName !== '..'
      ? responseName
      : `${path.basename(artifact.field)}-${Date.now()}`;
  return path.resolve(req.meta?.cwd ?? host.cwd, fileName);
}

type DownloadRemoteArtifactParams = {
  baseUrl: string;
  token: string;
  artifactId: string;
  destinationPath: string;
  requestScope: DaemonWireRequest['meta'];
  timeoutMs?: number;
  /** Whether `destinationPath` is a caller-owned root rather than one file to create. */
  isDirectory?: boolean;
  /** A capped download into a new private file (`artifact-download.ts`). */
  privateFile?: Readonly<{ maxBytes: number }>;
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

function buildDaemonArtifactUrl(baseUrl: string, artifactId: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(`artifacts/${encodeURIComponent(artifactId)}`, normalizedBase).toString();
}

function isRemoteDaemon(info: DaemonArtifactEndpoint): boolean {
  return typeof info.baseUrl === 'string' && info.baseUrl.length > 0;
}
