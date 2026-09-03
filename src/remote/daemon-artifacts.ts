import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonArtifact, DaemonRequest, DaemonResponse } from '../daemon/types.ts';
import {
  appendRecordingExtensionWhenMissing,
  recordingExtensionForPlatform,
} from '../recording/output-path.ts';
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

type PreparedRemoteRequest = {
  positionals: string[];
  flags?: DaemonRequest['flags'];
  installSource?: NonNullable<DaemonRequest['meta']>['installSource'];
  uploadedArtifactId?: string;
  clientArtifactPaths?: Record<string, string>;
};

export async function prepareRemoteRequestArtifacts(
  req: Omit<DaemonRequest, 'token'>,
  info: DaemonArtifactEndpoint,
): Promise<PreparedRemoteRequest> {
  const positionals = [...(req.positionals ?? [])];
  let flags = req.flags ? { ...req.flags } : undefined;
  let installSource = req.meta?.installSource;
  const clientArtifactPaths: Record<string, string> = {};
  let uploadedArtifactId: string | undefined;
  const uploadProgress = createStderrUploadProgressReporter();

  if (!isRemoteDaemon(info)) {
    return createPreparedRemoteRequest({
      positionals,
      flags,
      installSource,
      uploadedArtifactId,
      clientArtifactPaths,
    });
  }

  assertRemoteDaemonSupportsSaveScript(req);
  flags = applyRemoteArtifactCommand(req, positionals, flags, clientArtifactPaths);
  const remoteInstallSource = await prepareRemoteInstallSource(req, info, uploadProgress);
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
  );
  uploadedArtifactId = installPackageResult ?? uploadedArtifactId;
  return baseResult();
}

/**
 * #1802 (the other half of the caller/daemon file split): `--save-script` WRITES a `.ad` file,
 * and the writer is the daemon's `SessionScriptWriter` — on the daemon's own disk, next to a
 * source path that does not exist there. Reading was fixed by sending script sources with the
 * request; writing has no such symmetric path yet (the healed script commits at session teardown,
 * not in the replay response), so a remote request that would produce a file the caller can never
 * see is refused here instead of appearing to succeed. Tracked for the return-the-healed-script
 * response plumbing.
 */
function assertRemoteDaemonSupportsSaveScript(req: Omit<DaemonRequest, 'token'>): void {
  if (req.flags?.saveScript === undefined) return;
  throw new AppError(
    'INVALID_ARGS',
    '--save-script is not supported against a remote daemon: the healed script would be written on the daemon host, not on this machine.',
    {
      hint: 'Run the script against a local daemon to capture a healed .ad, or re-run without --save-script.',
      command: req.command,
    },
  );
}

async function prepareRemoteInstallPackage(
  req: Omit<DaemonRequest, 'token'>,
  info: DaemonArtifactEndpoint,
  positionals: string[],
  onProgress: UploadProgressSink | undefined,
): Promise<string | undefined> {
  const pathIndex = positionals.length === 1 ? 0 : 1;
  const rawPath = positionals[pathIndex];
  if (rawPath === undefined) return undefined;
  if (rawPath.startsWith('remote:')) {
    positionals[pathIndex] = rawPath.slice('remote:'.length);
    return undefined;
  }

  const localPath = resolveLocalInstallPath(rawPath, req.meta?.cwd);
  if (!localPath) return undefined;

  return await uploadArtifact({
    localPath,
    baseUrl: info.baseUrl!,
    token: info.token,
    platform: req.flags?.platform,
    onProgress,
  });
}

function applyRemoteArtifactCommand(
  req: Omit<DaemonRequest, 'token'>,
  positionals: string[],
  flags: DaemonRequest['flags'] | undefined,
  clientArtifactPaths: Record<string, string>,
): DaemonRequest['flags'] | undefined {
  const remoteArtifact = prepareRemoteArtifactCommand(req, positionals);
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
  flags: DaemonRequest['flags'] | undefined,
  flagKey: string,
  flagPath: string | undefined,
): DaemonRequest['flags'] | undefined {
  if (flagPath === undefined) return flags;
  return { ...(flags ?? {}), [flagKey]: flagPath };
}

function resolveLocalInstallPath(rawPath: string, cwd: string | undefined): string | undefined {
  const localPath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(cwd ?? process.cwd(), rawPath);
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
  req: Omit<DaemonRequest, 'token'>,
  info: DaemonArtifactEndpoint,
  onProgress: UploadProgressSink | undefined,
): Promise<{
  installSource: NonNullable<DaemonRequest['meta']>['installSource'];
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
    : path.resolve(req.meta?.cwd ?? process.cwd(), rawPath);
  if (!fs.existsSync(localPath)) {
    return {
      installSource: {
        ...source,
        path: localPath,
      },
    };
  }

  const uploadedArtifactId = await uploadArtifact({
    localPath,
    baseUrl: info.baseUrl!,
    token: info.token,
    platform: req.flags?.platform,
    onProgress,
  });
  return {
    installSource: {
      ...source,
      path: localPath,
    },
    uploadedArtifactId,
  };
}

function prepareRemoteArtifactCommand(
  req: Omit<DaemonRequest, 'token'>,
  positionals: string[],
): {
  field: string;
  localPath: string;
  positionalIndex?: number;
  positionalPath?: string;
  flagKey?: string;
  flagPath?: string;
} | null {
  if (req.command === 'screenshot') {
    const localPath = resolveClientArtifactOutputPath(req, 'path', '.png');
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
  if (req.command === 'record' && (positionals[0] ?? '').toLowerCase() === 'start') {
    if (!recordingHasRequestedClientPath(req) && req.flags?.platform === undefined) {
      return null;
    }
    const fallbackExtension = recordingFallbackExtension(req);
    const localPath = normalizeRecordingClientArtifactPath(
      resolveClientArtifactOutputPath(req, 'outPath', fallbackExtension, 1),
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
  if (req.command === 'test') {
    // #2246: `test` always materializes a suite artifacts directory, whether or not the caller
    // passed `--artifacts-dir` — unlike `record`, there is no "nothing to redirect" case here.
    // Resolving the caller-local root here (not on the daemon) mirrors #1802's read-side fix for
    // the same command: the daemon must never resolve a path against the caller's `cwd`.
    return {
      field: 'artifactsDir',
      localPath: resolveClientArtifactOutputRoot(req),
      flagKey: 'artifactsDir',
      flagPath: buildRemoteTempArtifactDirPath('test-artifacts'),
    };
  }
  return null;
}

function resolveClientArtifactOutputRoot(req: Omit<DaemonRequest, 'token'>): string {
  const requested = req.flags?.artifactsDir;
  const rawPath = hasNonEmptyString(requested) ? requested : DEFAULT_TEST_ARTIFACTS_ROOT;
  return resolveAbsoluteClientPath(rawPath, req.meta?.cwd);
}

function recordingFallbackExtension(req: Omit<DaemonRequest, 'token'>): string {
  return recordingExtensionForPlatform(req.flags?.platform);
}

function recordingHasRequestedClientPath(req: Omit<DaemonRequest, 'token'>): boolean {
  return hasNonEmptyString(req.positionals?.[1]) || hasNonEmptyString(req.flags?.out);
}

function normalizeRecordingClientArtifactPath(
  localPath: string,
  req: Omit<DaemonRequest, 'token'>,
): string {
  if (req.flags?.platform !== 'web') return localPath;
  return appendRecordingExtensionWhenMissing(localPath, recordingFallbackExtension(req));
}

function resolveClientArtifactOutputPath(
  req: Omit<DaemonRequest, 'token'>,
  field: 'path' | 'outPath',
  fallbackExtension: string,
  positionalIndex: number = 0,
): string {
  const requested = req.positionals?.[positionalIndex] ?? req.flags?.out;
  const fallbackName = `${field === 'path' ? 'screenshot' : 'recording'}-${Date.now()}${fallbackExtension}`;
  return resolveAbsoluteClientPath(
    hasNonEmptyString(requested) ? requested : fallbackName,
    req.meta?.cwd,
  );
}

/** Shared tail of every "what local path did the caller mean" resolution in this file. */
function resolveAbsoluteClientPath(rawPath: string, cwd: string | undefined): string {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd ?? process.cwd(), rawPath);
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildRemoteTempArtifactPath(prefix: string, extension: string): string {
  const safeExtension = extension.startsWith('.') ? extension : `.${extension}`;
  return path.posix.join(
    '/tmp',
    `agent-device-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeExtension}`,
  );
}

/** A directory temp path — unlike `buildRemoteTempArtifactPath`, no extension is ever appended. */
function buildRemoteTempArtifactDirPath(prefix: string): string {
  return path.posix.join(
    '/tmp',
    `agent-device-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

export async function materializeRemoteArtifacts(
  info: DaemonArtifactEndpoint,
  req: DaemonRequest,
  response: Extract<DaemonResponse, { ok: true }>,
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
    const downloadPath = resolveMaterializedArtifactPath(artifact, req);
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

function resolveMaterializedArtifactPath(artifact: DaemonArtifact, req: DaemonRequest): string {
  if (artifact.localPath && artifact.localPath.trim().length > 0) {
    return artifact.localPath;
  }
  const requestedPath = req.meta?.clientArtifactPaths?.[artifact.field];
  if (requestedPath && requestedPath.trim().length > 0) {
    return requestedPath;
  }
  const fallbackName = artifact.fileName?.trim() || `${artifact.field}-${Date.now()}`;
  return path.resolve(req.meta?.cwd ?? process.cwd(), fallbackName);
}

type DownloadRemoteArtifactParams = {
  baseUrl: string;
  token: string;
  artifactId: string;
  destinationPath: string;
  requestScope: DaemonRequest['meta'];
  timeoutMs?: number;
  /** Whether `destinationPath` is a caller-owned root rather than one file to create. */
  isDirectory?: boolean;
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
  });
}

function buildDaemonArtifactUrl(baseUrl: string, artifactId: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(`artifacts/${encodeURIComponent(artifactId)}`, normalizedBase).toString();
}

function isRemoteDaemon(info: DaemonArtifactEndpoint): boolean {
  return typeof info.baseUrl === 'string' && info.baseUrl.length > 0;
}
