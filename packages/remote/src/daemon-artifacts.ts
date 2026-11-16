import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
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
  const endpoint = { baseUrl: info.baseUrl, token: info.token };
  const artifacts = Array.isArray(response.data?.artifacts) ? response.data.artifacts : [];
  // A batch answers with one entry per step, and a step's own script artifact sits inside its result,
  // so a batch is delivered by its own path rather than as one payload.
  if (req.command === BATCH_COMMAND) {
    const data = response.data ?? {};
    const disclosure = await deliverBatchScript(endpoint, req, data, stateDir);
    return disclosure === undefined ? response : { ok: true, data: { ...data, ...disclosure } };
  }
  const download = (scripts?: SessionScriptDelivery) =>
    downloadResponseArtifacts(endpoint, req, response, host, scripts);
  if (
    response.data?.scriptPublicationId === undefined &&
    !artifacts.some(isSessionScriptArtifact)
  ) {
    return await download();
  }
  const { sessionScriptDelivery } = await import('./session-script-destination.ts');
  const scripts = sessionScriptDelivery(endpoint, req, response, stateDir, downloadRemoteArtifact);
  return await scripts.settleAfter(download);
}

/**
 * Delivers the session script of the steps a FAILED remote `batch` had completed, and answers the
 * fields its error should disclose about that delivery. The caller keeps its own error either way.
 *
 * Never throws: a request the daemon answered still has to settle with its own error.
 */
export async function materializeRemoteBatchPartialArtifacts(
  info: DaemonArtifactEndpoint,
  req: DaemonWireRequest,
  details: Record<string, unknown> | undefined,
  stateDir: string,
): Promise<Record<string, unknown> | undefined> {
  if (!info.baseUrl || req.command !== BATCH_COMMAND || !Array.isArray(details?.partialResults))
    return undefined;
  try {
    const { readBatchPlan, readFinishedStepCount } = await import('./remote-batch-answer.ts');
    const plan = readBatchPlan(req.flags?.batchSteps);
    const disclosure = await deliverBatchScript(
      { baseUrl: info.baseUrl, token: info.token },
      req,
      { results: details.partialResults },
      stateDir,
      readFinishedStepCount(plan, details),
    );
    return disclosure ? { ...details, ...disclosure } : undefined;
  } catch (error) {
    const { emitDiagnostic } = await import('@agent-device/host-kit/diagnostics');
    emitDiagnostic({
      level: 'warn',
      phase: 'session_script_delivery_failed',
      data: { session: req.session, error: String(error) },
    });
    return undefined;
  }
}

/**
 * Delivers a remote `batch` answer's session script: AT MOST ONE version, the newest this client's own
 * plan is owed. Every version is the whole recording, so an older one is worth nothing, and this never
 * changes the batch's outcome. The plan is the only authority — a step the caller never ran, or never
 * finished, authorizes no download and no retirement.
 */
async function deliverBatchScript(
  endpoint: Required<DaemonArtifactEndpoint>,
  req: DaemonWireRequest,
  data: Record<string, unknown>,
  stateDir: string,
  finished?: number,
): Promise<Record<string, unknown> | undefined> {
  // Both owners load on demand: the batch readers pull in the command registry, and the script owner
  // the download path, neither of which the client evaluates for a response that names no script.
  const [{ isPublishableScriptVersion, sessionScriptDelivery }, answer] = await Promise.all([
    import('./session-script-destination.ts'),
    import('./remote-batch-answer.ts'),
  ]);
  const plan = answer.readBatchPlan(req.flags?.batchSteps);
  const finishedCount = finished ?? plan.length;
  const steps = answer.readFinishedSteps(
    Array.isArray(data.results) ? data.results : [],
    plan,
    finishedCount,
  );
  const listed = asArtifacts(data.artifacts);
  // The batch's own payload is scanned FIRST: after the last step the daemon stamps its newest version
  // there, and the bound below keeps that version even by an answer that crowds the step entries out.
  const newest = newestScriptVersion(
    [listed, ...steps.map((step) => asArtifacts(step.data?.artifacts))],
    isPublishableScriptVersion,
  );
  const version = newest?.artifact;
  // Where that version came from, in plan order. The batch payload is stamped after the LAST step, so
  // it sits past every step: a version from there supersedes a failure an earlier step reported.
  const deliveredFrom =
    newest === undefined ? undefined : newest.source === 0 ? steps.length : newest.source - 1;
  const publication = batchPublicationId(steps, data) ?? version?.scriptPublicationId;
  // A close the PLAN ran and finished ends the recording, and the caller stops tracking it — with or
  // without a version to deliver. The owner locates the record by hashing this client's own endpoint,
  // tenant and session with that ID, so an ID the daemon invents retires nothing.
  const closed = answer.readFinishedClose(plan, finishedCount) ? publication : undefined;
  if (version === undefined && closed === undefined) return undefined;
  // The answer's own list is rewritten the way a single response's is: its session-script entries are
  // the owner's to answer for, and the one it delivers comes back with `localPath`.
  const listedScripts = listed.some(isSessionScriptArtifact);
  const kept = listed.filter((artifact) => !isSessionScriptArtifact(artifact));
  const payload: Record<string, unknown> = {};
  const scripts = sessionScriptDelivery(
    endpoint,
    req,
    { ok: true, data: payload },
    stateDir,
    downloadRemoteArtifact,
    closed,
  );
  await scripts.settleAfter(async () => {
    if (version !== undefined) await scripts.publish(version, payload, kept);
    return { ok: true, data: payload };
  });
  return answer.readBatchDisclosure(
    payload,
    steps,
    deliveredFrom,
    publication,
    listedScripts ? kept : undefined,
  );
}

/** The recording this batch reports, from what the answer names: only a recorded one can be opened. */
function batchPublicationId(
  steps: ReadonlyArray<{ data: Record<string, unknown> | undefined }>,
  data: Record<string, unknown>,
): string | undefined {
  return [...steps.map((step) => step.data?.scriptPublicationId), data.scriptPublicationId].find(
    (id): id is string => typeof id === 'string',
  );
}

function asArtifacts(value: unknown): DaemonArtifact[] {
  return Array.isArray(value) ? (value as DaemonArtifact[]) : [];
}

/**
 * The newest script version among these payloads' artifact lists, with the index of the list that
 * carried it, or `undefined`. The scan is linear and bounded per list and in all, so one answer cannot
 * make this client read what it is not owed, and a version past a bound is never inspected. Each
 * candidate passes the publisher's own guard, so no response value that cannot name a version reaches
 * a record lookup, a path, or a download request.
 */
function newestScriptVersion(
  lists: readonly DaemonArtifact[][],
  isPublishable: (artifact: DaemonArtifact | undefined) => boolean,
): { artifact: DaemonArtifact; source: number } | undefined {
  let newest: { artifact: DaemonArtifact; source: number } | undefined;
  let scanned = 0;
  lists.forEach((list, source) => {
    for (const artifact of list.slice(0, MAX_SCRIPT_ARTIFACTS_PER_ENTRY)) {
      if (scanned >= MAX_SCRIPT_ARTIFACTS_PER_BATCH) return;
      scanned += 1;
      if (!isPublishable(artifact)) continue;
      if (newest === undefined || (artifact.scriptRevision as number) > revisionOf(newest.artifact))
        newest = { artifact, source };
    }
  });
  return newest;
}

/** The revision one publishable artifact names. */
function revisionOf(artifact: DaemonArtifact): number {
  return artifact.scriptRevision as number;
}

/** Command name of the request that runs several steps under one response. */
const BATCH_COMMAND = 'batch';

/** One payload is read for at most this many of its own script artifacts. */
const MAX_SCRIPT_ARTIFACTS_PER_ENTRY = 32;

/** One batch answer is read for at most this many script artifacts in all. */
const MAX_SCRIPT_ARTIFACTS_PER_BATCH = 64;

async function downloadResponseArtifacts(
  endpoint: Required<DaemonArtifactEndpoint>,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  host: HostEnvironment,
  scripts: SessionScriptDelivery | undefined,
): Promise<DaemonResponse> {
  const artifacts = Array.isArray(response.data?.artifacts) ? response.data.artifacts : [];
  if (artifacts.length === 0) return response;
  const nextData = response.data ? { ...response.data } : {};
  const nextArtifacts: DaemonArtifact[] = [];
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object' || typeof artifact.artifactId !== 'string') {
      nextArtifacts.push(artifact);
      continue;
    }
    // `savedScript` and the session-script type are reserved for the session-script owner, which
    // drops a script artifact under another field or of another type.
    if (scripts && isSessionScriptArtifact(artifact)) {
      await scripts.publish(artifact, nextData, nextArtifacts);
      continue;
    }
    const downloadPath = resolveMaterializedArtifactPath(artifact, req, host);
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

function isSessionScriptArtifact(artifact: DaemonArtifact | undefined): boolean {
  return artifact?.field === 'savedScript' || artifact?.artifactType === 'session-script';
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
 * Where this client writes one downloaded artifact. The client chooses: a path it registered in
 * this request wins, and a response `localPath` is accepted only on a stop or report that echoes an
 * earlier request's destination. Anything else lands in cwd under the response file name's basename.
 */
function resolveMaterializedArtifactPath(
  artifact: DaemonArtifact,
  req: DaemonWireRequest,
  host: HostEnvironment,
): string {
  const requestedPath = req.meta?.clientArtifactPaths?.[artifact.field];
  if (hasNonEmptyString(requestedPath)) return requestedPath;
  if (hasNonEmptyString(artifact.localPath) && finishesEarlierClientCapture(req)) {
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
