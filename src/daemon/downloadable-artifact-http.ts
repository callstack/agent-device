import fs from 'node:fs';
import http from 'node:http';
import { normalizeError } from '../kernel/errors.ts';
import type { DaemonRequest } from './types.ts';
import {
  cleanupDownloadableArtifact,
  listDownloadableArtifacts,
  prepareDownloadableArtifact,
} from './artifact-tracking.ts';
import { sendRestJsonError, statusCodeForNormalizedError } from './http-errors.ts';

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
}): boolean {
  const { req, res, authorize, retainArtifacts } = params;
  const route = resolveDownloadableArtifactHttpRoute(req);
  if (route === null) return false;

  void handleDownloadableArtifactHttpRoute(route, req, res, authorize, { retainArtifacts });
  return true;
}

async function handleDownloadableArtifactHttpRoute(
  route: DownloadableArtifactHttpRoute,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorize: DownloadableArtifactHttpAuthorizer,
  options: { retainArtifacts?: boolean },
): Promise<void> {
  switch (route.kind) {
    case 'inventory':
      await handleArtifactInventory(req, res, authorize);
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
  options: { retainArtifacts?: boolean },
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

    const artifact = await prepareDownloadableArtifact(artifactId, auth.tenantId);
    const retainArtifactAfterDownload = options.retainArtifacts === true;
    const stream = fs.createReadStream(artifact.artifactPath);
    res.statusCode = 200;
    res.setHeader('content-type', artifact.mimeType);
    res.setHeader('content-length', String(artifact.sizeBytes));
    if (artifact.fileName) {
      res.setHeader(
        'content-disposition',
        `attachment; filename="${artifact.fileName.replace(/"/g, '')}"`,
      );
    }
    stream.on('error', (error) => {
      if (!res.headersSent) {
        const normalized = normalizeError(error);
        res.statusCode = statusCodeForNormalizedError(normalized.code);
        res.end(normalized.message);
      } else {
        res.destroy(error as Error);
      }
    });
    let didCleanupArtifact = false;
    const cleanupCompletedDownload = () => {
      if (didCleanupArtifact || retainArtifactAfterDownload) return;
      didCleanupArtifact = true;
      cleanupDownloadableArtifact(artifactId);
    };
    stream.on('end', cleanupCompletedDownload);
    res.on('finish', cleanupCompletedDownload);
    res.on('close', () => {
      if (res.writableFinished) {
        cleanupCompletedDownload();
      }
    });
    stream.pipe(res);
  } catch (error) {
    sendRestJsonError(res, normalizeError(error));
  }
}

async function handleArtifactInventory(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authorize: DownloadableArtifactHttpAuthorizer,
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
    res.end(JSON.stringify({ artifacts: await listDownloadableArtifacts(auth.tenantId) }));
  } catch (error) {
    sendRestJsonError(res, normalizeError(error));
  }
}

function readArtifactId(pathname: string): string {
  const encoded = pathname.slice('/artifacts/'.length);
  if (!encoded || encoded.includes('/')) return '';
  try {
    return decodeURIComponent(encoded);
  } catch {
    return '';
  }
}

function readRequestPathname(requestUrl: string | undefined): string {
  const requestTarget = requestUrl || '/';
  const queryIndex = requestTarget.indexOf('?');
  return queryIndex >= 0 ? requestTarget.slice(0, queryIndex) || '/' : requestTarget;
}
