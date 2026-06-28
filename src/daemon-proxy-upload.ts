import type { IncomingMessage } from 'node:http';
import { buildDaemonHttpAuthHeaders } from './daemon/http-contract.ts';

export function isSupportedProxyUploadRoute(route: string, method: string | undefined): boolean {
  if (route === '/upload') return method === 'POST';
  if (route === '/upload/preflight') return method === 'POST';
  if (route === '/upload/finalize') return method === 'POST';
  if (route.startsWith('/upload/direct/')) return method === 'PUT';
  return false;
}

export function shouldRewriteUploadProxyResponse(route: string): boolean {
  return route === '/upload/preflight';
}

export function rewriteUploadPreflightResponse(
  body: string,
  req: IncomingMessage,
  clientToken: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return body;
  }

  if (!parsed || typeof parsed !== 'object') return body;
  const record = parsed as { upload?: { url?: unknown; headers?: unknown } };
  if (!record.upload || typeof record.upload.url !== 'string') {
    return body;
  }

  const rewrittenUrl = rewriteUploadDirectUrl(record.upload.url, req);
  if (!rewrittenUrl) return body;

  const headers =
    record.upload.headers && typeof record.upload.headers === 'object'
      ? { ...(record.upload.headers as Record<string, unknown>) }
      : {};
  Object.assign(headers, buildDaemonHttpAuthHeaders(clientToken));

  return JSON.stringify({
    ...(parsed as Record<string, unknown>),
    upload: {
      ...record.upload,
      url: rewrittenUrl,
      headers,
    },
  });
}

function rewriteUploadDirectUrl(upstreamUrl: string, req: IncomingMessage): string | null {
  let parsed: URL;
  try {
    parsed = new URL(upstreamUrl);
  } catch {
    return null;
  }

  if (!parsed.pathname.startsWith('/upload/')) {
    return null;
  }

  const host = typeof req.headers.host === 'string' ? req.headers.host : '';
  if (!host) return null;

  const requestPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  const uploadIndex = requestPath.lastIndexOf('/upload/preflight');
  const uploadPrefix = uploadIndex >= 0 ? requestPath.slice(0, uploadIndex) : '';
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const rewritten = new URL(`${proto || 'http'}://${host}`);
  rewritten.pathname = `${uploadPrefix}${parsed.pathname}`;
  rewritten.search = parsed.search;
  return rewritten.toString();
}
