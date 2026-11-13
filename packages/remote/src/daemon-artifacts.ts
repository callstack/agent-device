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
import { uploadArtifact } from './upload-client.ts';
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

  flags = prepareRemoteScriptOutput(req, positionals, flags, clientArtifactPaths, host);
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

function prepareRemoteScriptOutput(
  req: Omit<DaemonWireRequest, 'token'>,
  positionals: string[],
  flags: DaemonWireRequest['flags'],
  clientPaths: Record<string, string>,
  host: HostEnvironment,
): DaemonWireRequest['flags'] {
  const active = req.command === 'session_save_script';
  if (flags?.saveScript && req.command !== 'open') {
    throw new AppError('INVALID_ARGS', 'Remote --save-script is supported only on a fresh open.', {
      reason: 'remote_script_lifecycle_unsupported',
      hint: 'Use open --save-script, then session save-script before closing. Remote repaired-script output is not supported.',
    });
  }
  const requested = active ? positionals[0] : flags?.saveScript;
  if (!active && !requested) return flags;
  if (active && typeof requested !== 'string') return flags;
  const localPath = resolveUserPath(
    typeof requested === 'string' ? requested : `recording-${Date.now()}.ad`,
    { cwd: req.meta?.cwd ?? host.cwd, env: host.env },
  );
  if (!active && requested !== true && !req.flags?.force && fs.existsSync(localPath)) {
    throw new AppError('COMMAND_FAILED', `A file already exists at ${localPath}.`, {
      reason: 'script_target_exists',
      path: localPath,
      hint: 'Choose another output path or pass --force/--overwrite.',
    });
  }
  clientPaths.savedScript = localPath;
  const daemonPath = buildRemoteTempArtifactPath('script', '.ad');
  if (active) {
    positionals[0] = daemonPath;
    return flags;
  }
  return { ...flags, saveScript: daemonPath };
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

export async function materializeRemoteArtifacts(
  info: DaemonArtifactEndpoint,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  host: HostEnvironment,
): Promise<DaemonResponse> {
  const artifacts = Array.isArray(response.data?.artifacts) ? response.data.artifacts : [];
  if (artifacts.length === 0 || !info.baseUrl) return response;
  const nextData = response.data ? { ...response.data } : {};
  const nextArtifacts: DaemonArtifact[] = [];
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object' || typeof artifact.artifactId !== 'string') {
      nextArtifacts.push(artifact);
      continue;
    }
    const downloadPath = resolveMaterializedArtifactPath(artifact, req, host);
    const materializedPath = await downloadRemoteArtifact({
      baseUrl: info.baseUrl,
      token: info.token,
      artifactId: artifact.artifactId,
      destinationPath: downloadPath,
      requestScope: req.meta,
      // #2246: `test-artifacts` is the one directory-shaped artifact type today — known from the
      // response, before any bytes arrive, so cleanup-on-error can be decided up front instead of
      // racing the response headers (a directory destination must never be `rm`'d wholesale; see
      // `downloadRemoteArtifact`).
      isDirectory: artifact.artifactType === 'test-artifacts',
      ...(artifact.artifactType === 'session-script'
        ? { scriptForce: req.flags?.force === true || artifact.force === true }
        : {}),
    });
    // Directory artifacts download into a caller-owned root, then atomically publish their one
    // top-level entry beneath it. Use the path the download actually published rather than the
    // root hint sent over the wire; otherwise `artifactsDir` loses its suite invocation segment.
    nextData[artifact.field] = materializedPath;
    if (artifact.field === 'savedScript' && req.command === 'session_save_script') {
      nextData.message = `Published script: ${materializedPath}`;
    }
    nextArtifacts.push({
      ...artifact,
      localPath: materializedPath,
    });
  }
  nextData.artifacts = nextArtifacts;
  return { ok: true, data: nextData };
}

/**
 * Whether this request finishes a capture whose destination this client named in an EARLIER
 * request (`record start`, a perf or trace start with an output path). The daemon echoes that
 * destination, and the paths it derives from it, as `localPath`, because this process kept no
 * record of it. The finishing actions mirror the daemon's own (`request-finalization.ts`).
 */
function finishesEarlierClientCapture(req: DaemonWireRequest, artifact: DaemonArtifact): boolean {
  const [first, second, third] = (req.positionals ?? []).map((value) => value.toLowerCase());
  switch (req.command) {
    case 'session_save_script':
      return artifact.field === 'savedScript' && artifact.artifactType === 'session-script';
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
  if (hasNonEmptyString(artifact.localPath) && finishesEarlierClientCapture(req, artifact)) {
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
  scriptForce?: boolean;
};

export async function downloadRemoteArtifact(
  params: DownloadRemoteArtifactParams,
): Promise<string> {
  // Remote artifact transfer is not part of routine CLI startup. Keep the HTTP/archive owner out
  // of the eager command graph and load it only after a remote response names an artifact.
  const { downloadRemoteArtifactFromUrl } = await import('./artifact-download.ts');
  return await downloadRemoteArtifactFromUrl({
    artifactUrl: new URL(buildDaemonArtifactUrl(params.baseUrl, params.artifactId)),
    token: params.token,
    artifactId: params.artifactId,
    destinationPath: params.destinationPath,
    requestScope: params.requestScope,
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
    ...(params.isDirectory === undefined ? {} : { isDirectory: params.isDirectory }),
    ...(params.scriptForce === undefined ? {} : { scriptForce: params.scriptForce }),
  });
}

function buildDaemonArtifactUrl(baseUrl: string, artifactId: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(`artifacts/${encodeURIComponent(artifactId)}`, normalizedBase).toString();
}

function isRemoteDaemon(info: DaemonArtifactEndpoint): boolean {
  return typeof info.baseUrl === 'string' && info.baseUrl.length > 0;
}
