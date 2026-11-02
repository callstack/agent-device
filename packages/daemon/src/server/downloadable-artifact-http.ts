import http from 'node:http';
import { once } from 'node:events';
import { Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from '../core/daemon-request.ts';
import {
  cleanupDownloadableArtifact,
  listDownloadableArtifacts,
  openDownloadableArtifact,
} from '../resources/artifact-tracking.ts';
import { sendRestJsonError } from './http-errors.ts';
import { decodeUriSegment } from './http-request-target.ts';

type DownloadableArtifactHttpRoute =
  | { kind: 'inventory' }
  | { kind: 'download'; artifactId: string };

type DownloadableArtifactHttpAuthorizer = (params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  daemonRequest: Pick<DaemonRequest, 'command' | 'positionals'>;
}) => Promise<{ tenantId?: string } | null>;

export function tryHandleDownloadableArtifactHttpRoute(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  authorize: DownloadableArtifactHttpAuthorizer;
  retainArtifacts?: boolean;
  /** The runtime host's environment, handed to the directory-archive spawn. */
  hostEnv: NodeJS.ProcessEnv;
}): boolean {
  const { req, res, authorize, retainArtifacts, hostEnv } = params;
  const route = resolveDownloadableArtifactHttpRoute(req);
  if (route === null) return false;

  void handleDownloadableArtifactHttpRoute(route, req, res, authorize, {
    retainArtifacts,
    hostEnv,
  });
  return true;
}

async function handleDownloadableArtifactHttpRoute(
  route: DownloadableArtifactHttpRoute,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorize: DownloadableArtifactHttpAuthorizer,
  options: { retainArtifacts?: boolean; hostEnv: NodeJS.ProcessEnv },
): Promise<void> {
  switch (route.kind) {
    case 'inventory':
      await handleArtifactInventory(req, res, authorize, options);
      return;
    case 'download':
      await handleArtifactDownload(route.artifactId, req, res, authorize, options);
      return;
  }
}

function resolveDownloadableArtifactHttpRoute(
  req: http.IncomingMessage,
): DownloadableArtifactHttpRoute | null {
  if (req.method !== 'GET') return null;
  const pathname = readRequestPathname(req.url);
  if (pathname === '/artifacts' || pathname === '/artifacts/') {
    return { kind: 'inventory' };
  }
  if (!pathname.startsWith('/artifacts/')) return null;
  return { kind: 'download', artifactId: readArtifactId(pathname) };
}

async function handleArtifactDownload(
  artifactId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorize: DownloadableArtifactHttpAuthorizer,
  options: { retainArtifacts?: boolean; hostEnv: NodeJS.ProcessEnv },
): Promise<void> {
  if (!artifactId) {
    res.statusCode = 400;
    res.end('Missing artifact id');
    return;
  }

  try {
    const auth = await authorize({
      req,
      res,
      daemonRequest: {
        command: 'download_artifact',
        positionals: [artifactId],
      },
    });
    if (!auth) return;

    const artifact = await openDownloadableArtifact(artifactId, auth.tenantId, options.hostEnv);
    const { stream } = artifact;
    const closed = finished(stream, { cleanup: true }).catch(() => {});
    try {
      artifact.signal.throwIfAborted();
      if (stream.errored) throw stream.errored;
      if (stream.pending) await once(stream, 'ready', { signal: artifact.signal });
      res.statusCode = 200;
      res.setHeader('content-type', artifact.mimeType);
      res.setHeader('content-length', String(artifact.sizeBytes));
      if (artifact.fileName) {
        res.setHeader(
          'content-disposition',
          `attachment; filename="${artifact.fileName.replace(/"/g, '')}"`,
        );
      }
      let bytesRead = 0;
      const checked = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytesRead += chunk.length;
          if (bytesRead >= artifact.sizeBytes && options.retainArtifacts !== true) {
            cleanupDownloadableArtifact(artifactId);
          }
          callback(null, chunk);
        },
        flush(callback) {
          if (bytesRead !== artifact.sizeBytes) {
            callback(
              new AppError('COMMAND_FAILED', 'Artifact read did not match its declared size', {
                reason: 'artifact_size_mismatch',
                expectedBytes: artifact.sizeBytes,
                actualBytes: bytesRead,
              }),
            );
            return;
          }
          if (options.retainArtifacts !== true) cleanupDownloadableArtifact(artifactId);
          callback();
        },
      });
      await pipeline(stream, checked, res, { signal: artifact.signal });
    } finally {
      stream.destroy();
      await closed;
      artifact.release();
    }
  } catch (error) {
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    res.removeHeader('content-length');
    res.removeHeader('content-disposition');
    sendRestJsonError(res, normalizeError(error));
  }
}

async function handleArtifactInventory(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorize: DownloadableArtifactHttpAuthorizer,
  options: { hostEnv: NodeJS.ProcessEnv },
): Promise<void> {
  try {
    const auth = await authorize({
      req,
      res,
      daemonRequest: {
        command: 'list_artifacts',
        positionals: [],
      },
    });
    if (!auth) return;

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        artifacts: await listDownloadableArtifacts(auth.tenantId, options.hostEnv),
      }),
    );
  } catch (error) {
    sendRestJsonError(res, normalizeError(error));
  }
}

function readArtifactId(pathname: string): string {
  const encoded = pathname.slice('/artifacts/'.length);
  if (!encoded || encoded.includes('/')) return '';
  return decodeUriSegment(encoded);
}

function readRequestPathname(requestUrl: string | undefined): string {
  const requestTarget = requestUrl || '/';
  const queryIndex = requestTarget.indexOf('?');
  return queryIndex >= 0 ? requestTarget.slice(0, queryIndex) || '/' : requestTarget;
}
