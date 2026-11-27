import fs from 'node:fs';
// Type-only: a runtime `node:http` import would load it eagerly for every CLI command. The actual
// HTTP stack loads through `loadNodeHttpRequester` only when a remote daemon returns an artifact.
import type http from 'node:http';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { loadNodeHttpRequester } from '@agent-device/host-kit/transport';
import type { DaemonRequestMeta } from '@agent-device/kernel/contracts';
import {
  buildDaemonHttpAuthHeaders,
  buildDaemonHttpLeaseHeaders,
  buildDaemonHttpTenantHeaders,
} from '@agent-device/contracts/daemon-http';

/** Why a downloaded artifact is refused before it is written. */
const ARTIFACT_DOWNLOAD_REASONS = {
  // The remote artifact is larger than the bytes this download may hold.
  tooLarge: { reason: 'artifact_too_large' },
} as const satisfies ReasonTable<'remote transfer'>;

const REMOTE_ARTIFACT_DOWNLOAD_TIMEOUT_MS = 90_000;

/** An error answer is read this far for the diagnostic, then the response is dropped. */
const MAX_ERROR_BODY_CHARS = 65_536;

type RemoteArtifactRequest = {
  artifactUrl: URL;
  token: string;
  artifactId: string;
  requestScope: DaemonRequestMeta | undefined;
  timeoutMs?: number;
};

export type RemoteArtifactDownload = RemoteArtifactRequest & {
  destinationPath: string;
  /** Whether `destinationPath` is a caller-owned root rather than one file to create. */
  isDirectory?: boolean;
  stagedFile?: boolean;
};

/** An artifact held in memory, stopped once it crosses `maxBytes`, whatever `Content-Length` announced. */
export type RemoteArtifactFetch = RemoteArtifactRequest & { maxBytes: number };

function buildDownloadDestination(params: RemoteArtifactDownload) {
  const { destinationPath } = params;
  if (params.stagedFile) {
    return {
      prepare: async () => {
        await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
      },
      cleanupOnError: async () => {},
      materialize: (res: http.IncomingMessage, signal: AbortSignal) =>
        materializeStagedFile(res, destinationPath, signal),
    };
  }
  if (params.isDirectory) {
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

async function materializeStagedFile(
  res: http.IncomingMessage,
  destinationPath: string,
  signal: AbortSignal,
): Promise<string> {
  const parent = await fs.promises.realpath(path.dirname(destinationPath));
  const staging = await fs.promises.mkdtemp(path.join(parent, '.agent-device-download-'));
  const staged = path.join(staging, 'artifact');
  try {
    await pipeline(res, fs.createWriteStream(staged, { flags: 'wx', mode: 0o600 }), { signal });
    signal.throwIfAborted();
    await fs.promises.rename(staged, path.join(parent, path.basename(destinationPath)));
    return destinationPath;
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
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
            reason: ARTIFACT_DOWNLOAD_REASONS.tooLarge.reason,
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
  destination: {
    prepare(): Promise<void>;
    cleanupOnError(): Promise<void>;
    materialize(res: http.IncomingMessage, signal: AbortSignal): Promise<T>;
  },
): Promise<T> {
  const transport = await loadNodeHttpRequester(params.artifactUrl.protocol);
  await destination.prepare();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let materializationStarted = false;
    let timeoutError: AppError | undefined;
    const operation = new AbortController();
    const timeoutMs = params.timeoutMs ?? REMOTE_ARTIFACT_DOWNLOAD_TIMEOUT_MS;
    const settleOnce = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timeoutHandle);
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
      timeoutError = new AppError('COMMAND_FAILED', 'Remote artifact download timed out', {
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
