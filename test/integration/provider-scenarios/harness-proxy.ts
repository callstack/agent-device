import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import http from 'node:http';
import { createDaemonProxyServer, type DaemonProxyAuthenticate } from '@agent-device/proxy';
import { buildHttpRpcPayload } from '../../../src/daemon-client/daemon-client-rpc.ts';
import { withClientReplayScriptSources } from '../../../src/__tests__/test-utils/replay-script-source.fixtures.ts';
import { closeLoopbackServer, listenOnLoopback } from '@agent-device/test-kit';
import { commandRequest, responseToRpcResult } from './harness-rpc.ts';
import {
  type ProviderScenarioHarness,
  type ProviderScenarioRpcResult,
} from './harness.ts';

export type ProviderScenarioForwardedRequest = {
  method: string;
  route: string;
  requestBody: string;
  responseBody: string;
  authorization: string | undefined;
  tenantId: string | undefined;
  statusCode: number;
  upstreamErrorCode?: string;
};

export type ProviderScenarioProxy = {
  baseUrl: string;
  port: number;
  forwarded: ProviderScenarioForwardedRequest[];
  requestRpc: (
    authToken: string,
    payload: Record<string, unknown>,
  ) => Promise<ProviderScenarioRpcResult>;
  callCommand: (
    authToken: string,
    command: string,
    positionals?: string[],
    flags?: DaemonWireRequest['flags'],
    options?: {
      input?: DaemonWireRequest['input'];
      meta?: DaemonWireRequest['meta'];
      runtime?: DaemonWireRequest['runtime'];
      session?: string;
    },
  ) => Promise<ProviderScenarioRpcResult>;
  close: () => Promise<void>;
};

export type ProviderScenarioProxyOptions =
  | { clientToken: string; authenticate?: never }
  | { clientToken?: never; authenticate: DaemonProxyAuthenticate };

type JsonRpcResponseEnvelope = {
  result?: DaemonResponse;
  error?: { code: number; message: string; data?: Record<string, unknown> };
};

export async function createProviderScenarioProxy(
  daemon: ProviderScenarioHarness,
  options: ProviderScenarioProxyOptions,
): Promise<ProviderScenarioProxy> {
  const upstream = createRecordingUpstreamServer(daemon.httpPort);
  const upstreamPort = await listenOnLoopback(upstream.server);
  const proxy = createDaemonProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    upstreamToken: daemon.token,
    ...options,
  });
  let proxyPort: number;
  try {
    proxyPort = await listenOnLoopback(proxy);
  } catch (error) {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream.server);
    throw error;
  }

  const baseUrl = `http://127.0.0.1:${proxyPort}/agent-device`;
  let closed = false;
  const requestRpc: ProviderScenarioProxy['requestRpc'] = async (authToken, payload) => {
    const response = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return { statusCode: response.status, json: await response.json() };
  };

  return {
    baseUrl,
    port: proxyPort,
    forwarded: upstream.forwarded,
    requestRpc,
    callCommand: async (authToken, command, positionals = [], flags = {}, commandOptions = {}) => {
      const request = await withClientReplayScriptSources(
        commandRequest(authToken, command, positionals, flags, commandOptions),
      );
      const payload = buildHttpRpcPayload(request, { includeTokenParam: true });
      const result = await requestRpc(authToken, payload);
      const envelope = result.json as JsonRpcResponseEnvelope;
      const id = String(payload.id);
      if (envelope.result) return responseToRpcResult(envelope.result, id);
      return {
        statusCode: envelope.error?.code === -32000 ? 200 : result.statusCode,
        json: {
          jsonrpc: '2.0',
          id,
          error: envelope.error ?? { code: result.statusCode, message: '' },
        },
      };
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await closeLoopbackServer(proxy);
      await closeLoopbackServer(upstream.server);
    },
  };
}

function createRecordingUpstreamServer(upstreamPort: number): {
  server: http.Server;
  forwarded: ProviderScenarioForwardedRequest[];
} {
  const forwarded: ProviderScenarioForwardedRequest[] = [];
  const server = http.createServer((request, response) => {
    void handleRecordingUpstreamRequest(request, response, upstreamPort, forwarded);
  });
  return { server, forwarded };
}

type RecordingUpstreamResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

async function handleRecordingUpstreamRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  upstreamPort: number,
  forwarded: ProviderScenarioForwardedRequest[],
): Promise<void> {
  const target = allowlistedUpstreamTarget(request);
  if (!target) {
    response.statusCode = 404;
    response.end('not found');
    return;
  }

  let entry: ProviderScenarioForwardedRequest | undefined;
  try {
    const requestBody = await readRequestBody(request);
    entry = recordForwardedRequest(request, target.route, requestBody, forwarded);
    const upstreamResponse = await forwardToDaemon(upstreamPort, request, target.path, requestBody);
    recordUpstreamResponse(entry, upstreamResponse);
    sendUpstreamResponse(response, upstreamResponse);
  } catch (error) {
    if (entry && error instanceof Error && 'code' in error && typeof error.code === 'string') {
      entry.upstreamErrorCode = error.code;
    }
    response.statusCode = 502;
    response.end('upstream request failed');
  }
}

function allowlistedUpstreamTarget(
  request: http.IncomingMessage,
): { path: string; route: string } | undefined {
  const requestTarget = request.url ?? '/';
  if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) return undefined;

  let target: URL;
  try {
    target = new URL(requestTarget, 'http://provider-scenario.invalid');
  } catch {
    return undefined;
  }
  if (target.origin !== 'http://provider-scenario.invalid' || target.search || target.hash) {
    return undefined;
  }

  const route = target.pathname;
  const method = request.method;
  const isRpc = method === 'POST' && route === '/rpc';
  const isDiagnostics =
    method === 'GET' &&
    /^\/sessions\/(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+\/requests\/(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+\/diagnostics$/.test(
      route,
    );
  const isArtifactList = method === 'GET' && (route === '/artifacts' || route === '/artifacts/');
  const isArtifact = method === 'GET' && /^\/artifacts\/[0-9a-f-]+$/i.test(route);
  if (!isRpc && !isDiagnostics && !isArtifactList && !isArtifact) return undefined;
  return { path: route, route };
}

async function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function recordForwardedRequest(
  request: http.IncomingMessage,
  route: string,
  requestBody: Buffer,
  forwarded: ProviderScenarioForwardedRequest[],
): ProviderScenarioForwardedRequest {
  const tenantHeader = request.headers['x-agent-device-tenant'];
  const entry: ProviderScenarioForwardedRequest = {
    method: request.method ?? '',
    route,
    requestBody: requestBody.toString('utf8'),
    responseBody: '',
    authorization: request.headers.authorization,
    tenantId: Array.isArray(tenantHeader) ? tenantHeader.join(', ') : tenantHeader,
    statusCode: 0,
  };
  forwarded.push(entry);
  return entry;
}

async function forwardToDaemon(
  upstreamPort: number,
  request: http.IncomingMessage,
  allowedPath: string,
  requestBody: Buffer,
): Promise<RecordingUpstreamResponse> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      value === undefined ||
      ['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding'].includes(
        name,
      )
    ) {
      continue;
    }
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  if (requestBody.length > 0) headers['content-length'] = String(requestBody.length);
  return await new Promise((resolve, reject) => {
    const upstreamRequest = http.request(
      {
        hostname: '127.0.0.1',
        port: upstreamPort,
        path: allowedPath,
        method: request.method,
        headers,
      },
      (upstreamReply) => {
        const responseChunks: Buffer[] = [];
        upstreamReply.on('data', (chunk: Buffer | string) => {
          responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        upstreamReply.on('end', () => {
          resolve({
            statusCode: upstreamReply.statusCode ?? 0,
            headers: upstreamReply.headers,
            body: Buffer.concat(responseChunks),
          });
        });
        upstreamReply.on('error', reject);
      },
    );
    upstreamRequest.on('error', reject);
    upstreamRequest.end(requestBody);
  });
}

function recordUpstreamResponse(
  entry: ProviderScenarioForwardedRequest,
  upstreamResponse: RecordingUpstreamResponse,
): void {
  entry.statusCode = upstreamResponse.statusCode;
  const contentTypeHeader = upstreamResponse.headers['content-type'];
  const contentType = Array.isArray(contentTypeHeader)
    ? contentTypeHeader.join(', ')
    : contentTypeHeader;
  if (contentType?.includes('json') || contentType?.startsWith('text/')) {
    entry.responseBody = upstreamResponse.body.toString('utf8');
  }
}

function sendUpstreamResponse(
  response: http.ServerResponse,
  upstreamResponse: RecordingUpstreamResponse,
): void {
  response.statusCode = upstreamResponse.statusCode;
  for (const name of ['content-type', 'content-disposition', 'content-length', 'x-request-id']) {
    const value = upstreamResponse.headers[name];
    if (value) response.setHeader(name, value);
  }
  response.end(upstreamResponse.body);
}
