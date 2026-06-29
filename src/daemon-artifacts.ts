import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { AppError } from './kernel/errors.ts';
import type { DaemonArtifact, DaemonRequest, DaemonResponse } from './daemon/types.ts';
import { buildDaemonHttpAuthHeaders } from './daemon/http-contract.ts';
import {
  appendRecordingExtensionWhenMissing,
  recordingExtensionForPlatform,
} from './recording/output-path.ts';
import { uploadArtifact } from './upload-client.ts';
import { createStderrUploadProgressReporter, type UploadProgressSink } from './upload-progress.ts';

// Mirrors the current daemon RPC timeout, but artifact download timeouts may diverge.
const REMOTE_ARTIFACT_DOWNLOAD_TIMEOUT_MS = 90_000;

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
  if (remoteArtifact.positionalPath !== undefined) {
    positionals[remoteArtifact.positionalIndex] = remoteArtifact.positionalPath;
  }
  const nextFlags = applyRemoteArtifactOutFlag(flags, remoteArtifact.flagPath);
  clientArtifactPaths[remoteArtifact.field] = remoteArtifact.localPath;
  return nextFlags;
}

function applyRemoteArtifactOutFlag(
  flags: DaemonRequest['flags'] | undefined,
  flagPath: string | undefined,
): DaemonRequest['flags'] | undefined {
  if (flagPath === undefined) return flags;
  return { ...(flags ?? {}), out: flagPath };
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
  positionalIndex: number;
  positionalPath?: string;
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
  return null;
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
  const rawPath = hasNonEmptyString(requested) ? requested : fallbackName;
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(req.meta?.cwd ?? process.cwd(), rawPath);
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
    const localPath = resolveMaterializedArtifactPath(artifact, req);
    await downloadRemoteArtifact({
      baseUrl: info.baseUrl,
      token: info.token,
      artifactId: artifact.artifactId,
      destinationPath: localPath,
      requestId: req.meta?.requestId,
    });
    nextData[artifact.field] = localPath;
    nextArtifacts.push({
      ...artifact,
      localPath,
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

export async function downloadRemoteArtifact(params: {
  baseUrl: string;
  token: string;
  artifactId: string;
  destinationPath: string;
  requestId?: string;
  timeoutMs?: number;
}): Promise<void> {
  const artifactUrl = new URL(buildDaemonArtifactUrl(params.baseUrl, params.artifactId));
  const transport = artifactUrl.protocol === 'https:' ? https : http;
  await fs.promises.mkdir(path.dirname(params.destinationPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeoutMs = params.timeoutMs ?? REMOTE_ARTIFACT_DOWNLOAD_TIMEOUT_MS;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (error) {
        void fs.promises.rm(params.destinationPath, { force: true }).finally(() => reject(error));
        return;
      }
      resolve();
    };
    const request = transport.request(
      {
        protocol: artifactUrl.protocol,
        host: artifactUrl.hostname,
        port: artifactUrl.port,
        method: 'GET',
        path: artifactUrl.pathname + artifactUrl.search,
        headers: buildDaemonHttpAuthHeaders(params.token),
      },
      (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            settle(
              new AppError('COMMAND_FAILED', 'Failed to download remote artifact', {
                artifactId: params.artifactId,
                statusCode: res.statusCode,
                requestId: params.requestId,
                body,
              }),
            );
          });
          return;
        }
        res.on('aborted', () => {
          settle(
            new AppError('COMMAND_FAILED', 'Remote artifact download was interrupted', {
              artifactId: params.artifactId,
              requestId: params.requestId,
            }),
          );
        });
        void pipeline(res, fs.createWriteStream(params.destinationPath)).then(
          () => settle(),
          (error: unknown) => settle(error instanceof Error ? error : new Error(String(error))),
        );
      },
    );
    const timeoutHandle = setTimeout(() => {
      const timeoutError = new AppError('COMMAND_FAILED', 'Remote artifact download timed out', {
        artifactId: params.artifactId,
        requestId: params.requestId,
        timeoutMs,
      });
      settle(timeoutError);
      request.destroy(timeoutError);
    }, timeoutMs);
    request.on('error', (error) => {
      if (error instanceof AppError) {
        settle(error);
        return;
      }
      settle(
        new AppError(
          'COMMAND_FAILED',
          'Failed to download remote artifact',
          {
            artifactId: params.artifactId,
            requestId: params.requestId,
            timeoutMs,
          },
          error instanceof Error ? error : undefined,
        ),
      );
    });
    request.end();
  });
}

function buildDaemonArtifactUrl(baseUrl: string, artifactId: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(`artifacts/${encodeURIComponent(artifactId)}`, normalizedBase).toString();
}

function isRemoteDaemon(info: DaemonArtifactEndpoint): boolean {
  return typeof info.baseUrl === 'string' && info.baseUrl.length > 0;
}
