import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import fs from 'node:fs';
// Type-only: a runtime `node:http` import would load it eagerly for every CLI command. The actual
// HTTP stack loads through `loadNodeHttpRequester` only when a remote daemon returns an artifact.
import type http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@agent-device/kernel/errors';
import { loadNodeHttpRequester } from '@agent-device/host-kit/transport';
import type { DaemonRequestMeta } from '@agent-device/kernel/contracts';
import {
  buildDaemonHttpAuthHeaders,
  buildDaemonHttpLeaseHeaders,
  buildDaemonHttpTenantHeaders,
} from '@agent-device/contracts/daemon-http';

const REMOTE_ARTIFACT_DOWNLOAD_TIMEOUT_MS = 90_000;

export type RemoteArtifactDownload = {
  artifactUrl: URL;
  token: string;
  artifactId: string;
  destinationPath: string;
  requestScope: DaemonRequestMeta | undefined;
  timeoutMs?: number;
  /** Whether `destinationPath` is a caller-owned root rather than one file to create. */
  isDirectory?: boolean;
  scriptForce?: boolean;
};

type DownloadDestination = {
  prepare(): Promise<void>;
  cleanupOnError(): Promise<void>;
  materialize(res: http.IncomingMessage, signal: AbortSignal): Promise<string>;
};

function buildDownloadDestination(params: RemoteArtifactDownload): DownloadDestination {
  const { destinationPath } = params;
  if (params.scriptForce !== undefined) {
    return {
      prepare: async () => {},
      cleanupOnError: async () => {},
      materialize: (res, signal) =>
        materializeScriptArtifact(
          res,
          destinationPath,
          params.scriptForce === true,
          params.artifactId,
          signal,
        ),
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
      materialize: (res, signal) => materializeDirectoryArtifact(res, destinationPath, signal),
    };
  }
  return {
    prepare: async () => {
      await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    },
    cleanupOnError: () => fs.promises.rm(destinationPath, { force: true }),
    materialize: async (res, signal) => {
      await pipeline(res, fs.createWriteStream(destinationPath), { signal });
      return destinationPath;
    },
  };
}

/** Downloads an artifact and returns the exact file or directory published on the client. */
export async function downloadRemoteArtifactFromUrl(
  params: RemoteArtifactDownload,
): Promise<string> {
  const transport = await loadNodeHttpRequester(params.artifactUrl.protocol);
  const destination = buildDownloadDestination(params);
  await destination.prepare();
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let materializationStarted = false;
    let timeoutError: AppError | undefined;
    const operation = new AbortController();
    const timeoutMs = params.timeoutMs ?? REMOTE_ARTIFACT_DOWNLOAD_TIMEOUT_MS;
    const settle = (result?: string, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (error) {
        void destination.cleanupOnError().finally(() => reject(error));
        return;
      }
      resolve(result ?? params.destinationPath);
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
          res.on('data', (chunk) => {
            const remainingChars = 65536 - body.length;
            if (remainingChars > 0) body += chunk.slice(0, remainingChars);
          });
          const fail = () => {
            settle(
              undefined,
              new AppError('COMMAND_FAILED', 'Failed to download remote artifact', {
                artifactId: params.artifactId,
                statusCode: res.statusCode,
                requestId: params.requestScope?.requestId,
                body,
              }),
            );
          };
          res.on('end', fail);
          res.on('error', fail);
          res.on('aborted', fail);
          return;
        }
        materializationStarted = true;
        void destination.materialize(res, operation.signal).then(
          (materializedPath) => settle(materializedPath),
          (error: unknown) =>
            settle(
              undefined,
              timeoutError ?? (error instanceof Error ? error : new Error(String(error))),
            ),
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
      if (!materializationStarted) settle(undefined, timeoutError);
    }, timeoutMs);
    request.on('error', (error) => {
      if (materializationStarted) return;
      if (error instanceof AppError) {
        settle(undefined, timeoutError ?? error);
        return;
      }
      settle(
        undefined,
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

/** A failed or racing transfer never exposes a prefix or removes the caller's existing script. */
async function materializeScriptArtifact(
  res: http.IncomingMessage,
  destination: string,
  force: boolean,
  artifactId: string,
  signal: AbortSignal,
): Promise<string> {
  let staging: string | undefined;
  let publishing = false;
  try {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    staging = await fs.promises.mkdtemp(
      path.join(path.dirname(destination), '.agent-device-script-'),
    );
    const temporary = path.join(staging, 'script.ad');
    await pipeline(res, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
    signal.throwIfAborted();
    publishing = true;
    if (force) await fs.promises.rename(temporary, destination);
    else await fs.promises.link(temporary, destination);
    return destination;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `The remote script could not be saved to ${destination}.`,
      {
        reason:
          publishing && (error as NodeJS.ErrnoException).code === 'EEXIST'
            ? 'script_target_exists'
            : 'script_download_failed',
        path: destination,
        artifactId,
        hint: 'The daemon already published the script. Retry downloading the retained artifact by ID; do not repeat the device journey.',
      },
      error instanceof Error ? error : undefined,
    );
  } finally {
    if (staging) {
      try {
        await fs.promises.rm(staging, { recursive: true, force: true });
      } catch (error) {
        emitDiagnostic({
          level: 'warn',
          phase: 'script_download_cleanup_failed',
          data: { artifactId, path: staging, error: String(error) },
        });
      }
    }
  }
}
