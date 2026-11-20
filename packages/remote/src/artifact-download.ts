import fs from 'node:fs';
// Type-only: a runtime `node:http` import would load it eagerly for every CLI command. The actual
// HTTP stack loads through `loadNodeHttpRequester` only when a remote daemon returns an artifact.
import type http from 'node:http';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { loadNodeHttpRequester } from '@agent-device/host-kit/transport';
import type { DaemonRequestMeta } from '@agent-device/kernel/contracts';
import {
  buildDaemonHttpAuthHeaders,
  buildDaemonHttpLeaseHeaders,
  buildDaemonHttpTenantHeaders,
} from '@agent-device/contracts/daemon-http';

const REMOTE_ARTIFACT_DOWNLOAD_TIMEOUT_MS = 90_000;

/** An error answer is read this far for the diagnostic, then the response is dropped. */
const MAX_ERROR_BODY_CHARS = 65_536;

type RemoteArtifactRequest = {
  artifactUrl: URL;
  token: string;
  artifactId: string;
  requestScope: DaemonRequestMeta | undefined;
  timeoutMs?: number;
  /** The caller's cancellation. An abort stops the transfer and any publish, then cleans up. */
  signal?: AbortSignal;
};

/**
 * How a download lands at `destinationPath`: one file written in place, a caller-owned root that
 * receives one extracted directory, or one file staged privately beside the destination (#4518),
 * where no link at the name or replaced parent redirects the bytes. `staged-file` renames over the
 * caller's destination; `staged-new-file` refuses an occupied destination.
 */
export type RemoteArtifactDestinationMode =
  | 'file'
  | 'directory'
  | 'staged-file'
  | 'staged-new-file';

export type RemoteArtifactDownload = RemoteArtifactRequest & {
  destinationPath: string;
  /** Defaults to `file`. */
  mode?: RemoteArtifactDestinationMode;
};

/**
 * The `details.reason` values a staged remote recording download publishes (#4518), documented in
 * `website/docs/docs/commands.md`.
 */
const ARTIFACT_DOWNLOAD_REASONS = {
  /** The download's parent directory was replaced or became unreachable during the transfer. */
  destinationReplaced: 'artifact_destination_replaced',
  /** The staging directory could not be created, or the staged file could not be renamed. */
  publishFailed: 'artifact_publish_failed',
} as const;

const PRIVATE_FILE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  (fs.constants.O_NOFOLLOW ?? 0);

type DownloadDestination<T> = {
  prepare(): Promise<void>;
  cleanupOnError(): Promise<void>;
  materialize(res: http.IncomingMessage, signal: AbortSignal): Promise<T>;
};

/** An artifact held in memory, stopped once it crosses `maxBytes`, whatever `Content-Length` announced. */
export type RemoteArtifactFetch = RemoteArtifactRequest & { maxBytes: number };

function buildDownloadDestination(params: RemoteArtifactDownload): DownloadDestination<string> {
  const { destinationPath } = params;
  if (params.mode === 'staged-file' || params.mode === 'staged-new-file') {
    return stagedFileDestination(params);
  }
  if (params.mode === 'directory') {
    return {
      prepare: async () => {
        await fs.promises.mkdir(destinationPath, { recursive: true });
      },
      // The root belongs to the caller and may contain earlier runs. Directory materialization
      // owns and cleans its hidden staging directory, so the root itself is never removed.
      cleanupOnError: async () => {},
      materialize: (res: http.IncomingMessage, signal: AbortSignal) =>
        materializeDirectoryArtifact(res, destinationPath, signal),
    };
  }
  return {
    prepare: async () => {
      await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    },
    cleanupOnError: () => fs.promises.rm(destinationPath, { force: true }),
    materialize: async (res: http.IncomingMessage, signal: AbortSignal) => {
      await pipeline(res, fs.createWriteStream(destinationPath), { signal });
      return destinationPath;
    },
  };
}

function stagedFileDestination(params: RemoteArtifactDownload): DownloadDestination<string> {
  const { destinationPath, artifactId } = params;
  const parent = path.dirname(destinationPath);
  // Staging, publishing and cleanup all use this one resolved parent and its identity.
  let anchor: { path: string; identity: string | undefined } | undefined;
  let staging: string | undefined;
  let file: fs.promises.FileHandle | undefined;
  /** Whether the anchored directory is still the one staging was created in. */
  const anchorKept = (): boolean =>
    anchor?.identity !== undefined && directoryIdentity(anchor.path) === anchor.identity;
  /** Cleanup acts only inside the anchored directory, never inside one that replaced it. */
  const removeStaging = async (): Promise<void> => {
    await file?.close().catch(() => undefined);
    if (staging && anchorKept()) fs.rmSync(staging, { recursive: true, force: true });
  };
  return {
    prepare: async () => {
      try {
        await fs.promises.mkdir(parent, { recursive: true });
        const physical = fs.realpathSync(parent);
        anchor = { path: physical, identity: directoryIdentity(physical) };
        if (anchor.identity === undefined) throw new Error(`${physical} is not a directory`);
        staging = fs.mkdtempSync(path.join(physical, '.agent-device-download-'));
        file = await fs.promises.open(path.join(staging, 'artifact'), PRIVATE_FILE_FLAGS, 0o600);
      } catch (error) {
        await removeStaging();
        throw publishError(artifactId, error);
      }
    },
    cleanupOnError: removeStaging,
    materialize: async (res, signal) => {
      const staged = path.join(staging!, 'artifact');
      await pipeline(res, file!.createWriteStream(), { signal });
      // The publish runs synchronously from here, so nothing interleaves after these checks.
      signal.throwIfAborted();
      if (!anchorKept() || realpathOrUndefined(parent) !== anchor!.path) {
        throw new AppError(
          'COMMAND_FAILED',
          'The download directory changed during the transfer.',
          {
            reason: ARTIFACT_DOWNLOAD_REASONS.destinationReplaced,
            artifactId,
          },
        );
      }
      const target = path.join(anchor!.path, path.basename(destinationPath));
      try {
        if (params.mode === 'staged-new-file') fs.linkSync(staged, target);
        else fs.renameSync(staged, target);
      } catch (error) {
        throw publishError(artifactId, error);
      }
      fs.rmSync(staging!, { recursive: true, force: true });
      return destinationPath;
    },
  };
}

function publishError(artifactId: string, cause: unknown): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'The downloaded artifact could not be saved on this machine.',
    { reason: ARTIFACT_DOWNLOAD_REASONS.publishFailed, artifactId },
    cause instanceof Error ? cause : undefined,
  );
}

function realpathOrUndefined(directory: string): string | undefined {
  try {
    return fs.realpathSync(directory);
  } catch {
    return undefined;
  }
}

/** A directory's identity from `lstat`, or `undefined` when it is not a reachable directory. */
function directoryIdentity(directory: string): string | undefined {
  try {
    const stat = fs.lstatSync(directory, { bigint: true });
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : undefined;
  } catch {
    // ENOENT, ENOTDIR or EACCES all mean the anchored directory can no longer be confirmed.
    return undefined;
  }
}

/** Fetches one artifact into memory. Nothing reaches the disk, so a failure leaves nothing behind. */
export async function fetchRemoteArtifactFromUrl(params: RemoteArtifactFetch): Promise<Buffer> {
  return await requestRemoteArtifact(params, {
    prepare: async () => {},
    cleanupOnError: async () => {},
    materialize: async (res, signal) => {
      const memory = boundedMemory(params.maxBytes, params.artifactId);
      await pipeline(res, memory.sink, { signal });
      return memory.bytes();
    },
  });
}

/**
 * Collects a body into ONE buffer that doubles up to `maxBytes` and refuses the chunk that crosses it, so
 * what is allocated depends on the bytes received and never on how many chunks carried them.
 */
function boundedMemory(maxBytes: number, artifactId: string) {
  let buffer = Buffer.allocUnsafe(Math.min(maxBytes, 64 * 1024));
  let length = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const needed = length + chunk.length;
      if (needed > maxBytes) {
        callback(
          new AppError('COMMAND_FAILED', `The remote artifact is larger than ${maxBytes} bytes.`, {
            reason: 'artifact_too_large',
            artifactId,
            maxBytes,
          }),
        );
        return;
      }
      if (needed > buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(needed, buffer.length * 2)));
        buffer.copy(grown, 0, 0, length);
        buffer = grown;
      }
      chunk.copy(buffer, length);
      length = needed;
      callback();
    },
  });
  return { sink, bytes: () => buffer.subarray(0, length) };
}

/** Downloads an artifact and returns the exact file or directory published on the client. */
export async function downloadRemoteArtifactFromUrl(
  params: RemoteArtifactDownload,
): Promise<string> {
  return await requestRemoteArtifact(params, buildDownloadDestination(params));
}

async function requestRemoteArtifact<T>(
  params: RemoteArtifactRequest,
  destination: DownloadDestination<T>,
): Promise<T> {
  const canceled = (): AppError =>
    createRequestCanceledError(
      { artifactId: params.artifactId, requestId: params.requestScope?.requestId },
      params.signal?.reason,
    );
  if (params.signal?.aborted) throw canceled();
  const transport = await loadNodeHttpRequester(params.artifactUrl.protocol);
  await destination.prepare();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let materializationStarted = false;
    let timeoutError: AppError | undefined;
    const operation = new AbortController();
    const timeoutMs = params.timeoutMs ?? REMOTE_ARTIFACT_DOWNLOAD_TIMEOUT_MS;
    // A caller abort stops the transfer like the timeout does, and settles only after cleanup.
    const onCallerAbort = (): void => {
      timeoutError ??= canceled();
      operation.abort(timeoutError);
      request.destroy(timeoutError);
      if (!materializationStarted) fail(timeoutError);
    };
    const settleOnce = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timeoutHandle);
      params.signal?.removeEventListener('abort', onCallerAbort);
      return true;
    };
    const succeed = (result: T) => {
      if (settleOnce()) resolve(result);
    };
    const fail = (error: Error) => {
      if (!settleOnce()) return;
      // A cleanup that fails is reported on its own; the caller still receives the download's own error.
      void destination
        .cleanupOnError()
        .catch((cleanupError: unknown) =>
          emitDiagnostic({
            level: 'warn',
            phase: 'remote_artifact_cleanup_failed',
            data: { artifactId: params.artifactId, error: String(cleanupError) },
          }),
        )
        .finally(() => reject(error));
    };
    const request = transport.request(
      {
        protocol: params.artifactUrl.protocol,
        host: params.artifactUrl.hostname,
        port: params.artifactUrl.port,
        method: 'GET',
        path: params.artifactUrl.pathname + params.artifactUrl.search,
        headers: {
          ...buildDaemonHttpAuthHeaders(params.token),
          ...buildDaemonHttpTenantHeaders(params.requestScope?.tenantId),
          ...buildDaemonHttpLeaseHeaders(params.requestScope?.leaseId),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let body = '';
          res.setEncoding('utf8');
          const failWithStatus = () => {
            fail(
              new AppError('COMMAND_FAILED', 'Failed to download remote artifact', {
                artifactId: params.artifactId,
                statusCode: res.statusCode,
                requestId: params.requestScope?.requestId,
                body,
              }),
            );
          };
          res.on('data', (chunk: string) => {
            body += chunk.slice(0, MAX_ERROR_BODY_CHARS - body.length);
            if (body.length < MAX_ERROR_BODY_CHARS) return;
            // The diagnostic is full: the rest of an error answer is never read.
            failWithStatus();
            res.destroy();
          });
          res.on('end', failWithStatus);
          res.on('error', failWithStatus);
          res.on('aborted', failWithStatus);
          return;
        }
        materializationStarted = true;
        void destination.materialize(res, operation.signal).then(
          (materializedPath) => succeed(materializedPath),
          (error: unknown) =>
            fail(timeoutError ?? (error instanceof Error ? error : new Error(String(error)))),
        );
      },
    );
    const timeoutHandle = setTimeout(() => {
      timeoutError ??= new AppError('COMMAND_FAILED', 'Remote artifact download timed out', {
        artifactId: params.artifactId,
        requestId: params.requestScope?.requestId,
        timeoutMs,
      });
      operation.abort(timeoutError);
      request.destroy(timeoutError);
      // The abort-aware materializer cleans its staging area. Do not reject before it finishes,
      // or extraction could keep writing after the caller observes the timeout.
      if (!materializationStarted) fail(timeoutError);
    }, timeoutMs);
    params.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (params.signal?.aborted) onCallerAbort();
    request.on('error', (error) => {
      if (materializationStarted) return;
      if (error instanceof AppError) {
        fail(timeoutError ?? error);
        return;
      }
      fail(
        new AppError(
          'COMMAND_FAILED',
          'Failed to download remote artifact',
          {
            artifactId: params.artifactId,
            requestId: params.requestScope?.requestId,
            timeoutMs,
          },
          error instanceof Error ? error : undefined,
        ),
      );
    });
    request.end();
  });
}

/** Safely extracts one directory and atomically publishes it under the caller-owned root. */
async function materializeDirectoryArtifact(
  res: http.IncomingMessage,
  destinationRoot: string,
  signal: AbortSignal,
): Promise<string> {
  // Staging beside the final entry guarantees one filesystem, so there is no EXDEV copy fallback
  // that could expose a partially copied suite.
  const tempDir = await fs.promises.mkdtemp(path.join(destinationRoot, '.agent-device-download-'));
  const archivePath = path.join(tempDir, 'artifact.tar.gz');
  const stagingRoot = path.join(tempDir, 'extracted');
  try {
    await pipeline(res, fs.createWriteStream(archivePath), { signal });
    const { extractArchiveSafely } = await import('@agent-device/host-kit/archive');
    await extractArchiveSafely({ archivePath, outputRoot: stagingRoot, type: 'tgz', signal });
    signal.throwIfAborted();
    const [entryName, ...extraEntries] = await fs.promises.readdir(stagingRoot);
    if (!entryName || extraEntries.length > 0) {
      throw new AppError(
        'COMMAND_FAILED',
        `Downloaded directory artifact has an unexpected shape: expected exactly one top-level entry, found ${extraEntries.length + (entryName ? 1 : 0)}`,
      );
    }
    signal.throwIfAborted();
    const materializedPath = path.join(destinationRoot, entryName);
    await fs.promises.rename(path.join(stagingRoot, entryName), materializedPath);
    return materializedPath;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}
