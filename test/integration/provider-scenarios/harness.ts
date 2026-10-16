import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAgentDeviceClient } from '../../../src/agent-device-client.ts';
import type { AgentDeviceClient } from '../../../src/client/client-types.ts';
import type { AgentDeviceDaemonTransport } from '@agent-device/contracts/client';
import type { AppleToolProvider } from '@agent-device/platform-apple/tool-provider';
import {
  startDaemonRuntime,
  type ComposeDaemonRuntimeDeps,
  type DaemonRuntimeDeps,
} from '@agent-device/daemon';
import { createDaemonProxyServer, type DaemonProxyAuthenticate } from '@agent-device/proxy';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { resolveSessionDir } from '@agent-device/daemon-contracts/session-artifact-paths';
import {
  buildHttpRpcPayload,
  handleDaemonHttpResponseBody,
} from '../../../src/daemon-client/daemon-client-rpc.ts';
import { createDaemonRuntimeDeps } from '../../../src/daemon-composition.ts';
import {
  createPlatformRuntimeGateway,
  createRequestPlatformProviders,
  type PlatformProviderResolvers,
} from '../../../src/platform-runtime.ts';
import type { AppleSimulatorScreenRecordingProcess } from '../../../src/platform-runtime-screen-recording-apple-transport.ts';
import { runCmdBackground } from '@agent-device/host-kit/command';
import { withClientReplayScriptSources } from '../../../src/__tests__/test-utils/replay-script-source.fixtures.ts';
import type {
  DeviceInventoryProvider,
  ProviderDeviceRuntime,
  ProviderDeviceInventorySource,
} from '@agent-device/contracts/device';
import {
  createTestDeviceInventoryGateways,
  createTestDeviceInventoryGatewaysFromProvider,
} from '@agent-device/device-selection/inventory-gateways-fixtures';
import { closeLoopbackServer, listenOnLoopback } from '@agent-device/test-kit';
import type { PlatformRuntimeProviderRegistration } from '../../../src/platform-runtime-gateway.ts';
import { createProviderPlatformRuntimeRegistrations } from '../../../src/provider-device-runtimes.ts';

const PROVIDER_SCENARIO_TEMP_REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50,
} as const;

export type ProviderScenarioRpcResult = { statusCode: number; json: any };

export type ProviderScenarioForwardedRequest = {
  method: string;
  route: string;
  requestBody: string;
  responseBody: string;
  authorization: string | undefined;
  tenantId: string | undefined;
  statusCode: number;
};

type JsonRpcResponseEnvelope = {
  result?: DaemonResponse;
  error?: { code: number; message: string; data?: Record<string, unknown> };
};

export type ProviderScenarioHarness = {
  callCommand: (
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
  client: () => AgentDeviceClient;
  hasSession: (session?: string) => Promise<boolean>;
  baseUrl: string;
  httpPort: number;
  token: string;
  sessionDir: (name?: string) => string;
  close: () => Promise<void>;
};

export type ProviderScenarioProxy = {
  baseUrl: string;
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

export type ClosableProviderScenarioResource = {
  close: () => Promise<void> | void;
};

export type ProviderScenarioPlatformRuntime = Readonly<{
  providerRuntimes: readonly ProviderDeviceRuntime[];
  providerModules: readonly PlatformRuntimeProviderRegistration[];
}>;

type ProviderScenarioDependencies = Partial<Omit<DaemonRuntimeDeps, 'requestRouter'>> &
  Partial<DaemonRuntimeDeps['requestRouter']> &
  Partial<PlatformProviderResolvers> &
  (
    | { deviceInventoryProvider: DeviceInventoryProvider; deviceInventorySource?: never }
    | { deviceInventorySource: ProviderDeviceInventorySource; deviceInventoryProvider?: never }
  ) & {
    providerRuntimes?: readonly ProviderDeviceRuntime[];
    platformRuntime?: ProviderScenarioPlatformRuntime;
    leaseTtlMs?: number;
  };

export async function createProviderScenarioHarness(
  deps: ProviderScenarioDependencies,
): Promise<ProviderScenarioHarness> {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-provider-scenario-'));
  const stateDir = path.join(testRoot, 'state');
  const daemonPaths = resolveDaemonPaths(stateDir);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    AGENT_DEVICE_STATE_DIR: stateDir,
    AGENT_DEVICE_CLAIMS_DIR: path.join(testRoot, 'claims'),
    AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '3600000',
  };
  const {
    deviceInventoryProvider,
    deviceInventorySource,
    deviceRuntimeGateway: configuredDeviceRuntimeGateway,
    platformRuntime,
    providerRuntimes,
    leaseTtlMs,
    requestPlatformProviders: configuredRequestPlatformProviders,
    androidAdbProvider,
    appleRunnerProvider,
    appleRunnerScreenRecordingTransport,
    appleToolProvider,
    linuxToolProvider,
    vegaToolProvider,
    webProvider,
    appleSimulatorScreenRecordingTransport,
    ...dependencyOverrides
  } = deps;
  if (leaseTtlMs !== undefined) env.AGENT_DEVICE_LEASE_TTL_MS = String(leaseTtlMs);

  let scopedAppleToolProvider: AppleToolProvider | undefined;
  const composeDeps: ComposeDaemonRuntimeDeps = async (input) => {
    const rootDeps = await createDaemonRuntimeDeps(input);
    const configuredRuntimes = platformRuntime?.providerRuntimes ?? providerRuntimes ?? [];
    const providerModules =
      platformRuntime?.providerModules ??
      createProviderPlatformRuntimeRegistrations(configuredRuntimes);
    const defaultDeviceRuntimeGateway = createPlatformRuntimeGateway({
      assertShutdownAllowed: input.assertShutdownAllowed,
      providerRuntimes: configuredRuntimes,
      providerModules,
      sessionsDir: input.sessionsDir,
      ownedProcesses: rootDeps.ownedProcessRecords,
      resolveSessionArtifacts: input.resolveSessionArtifacts,
    });
    const deviceRuntimeGateway = configuredDeviceRuntimeGateway
      ? Object.freeze({
          ...defaultDeviceRuntimeGateway,
          ...configuredDeviceRuntimeGateway,
          applicationLifecycle:
            configuredDeviceRuntimeGateway.applicationLifecycle ??
            defaultDeviceRuntimeGateway.applicationLifecycle,
        })
      : defaultDeviceRuntimeGateway;
    const deviceInventoryGateways = deviceInventorySource
      ? createTestDeviceInventoryGateways({ provider: deviceInventorySource })
      : createTestDeviceInventoryGatewaysFromProvider(deviceInventoryProvider);
    const trackedAppleToolProvider = appleToolProvider
      ? (context: Parameters<NonNullable<PlatformProviderResolvers['appleToolProvider']>>[0]) => {
          scopedAppleToolProvider = appleToolProvider(context);
          return scopedAppleToolProvider;
        }
      : undefined;
    const requestPlatformProviders =
      configuredRequestPlatformProviders ??
      createRequestPlatformProviders({
        providers: {
          androidAdbProvider,
          appleRunnerProvider,
          appleRunnerScreenRecordingTransport,
          appleToolProvider: trackedAppleToolProvider,
          linuxToolProvider,
          vegaToolProvider,
          webProvider,
          appleSimulatorScreenRecordingTransport,
        },
        defaultWebProvider: {
          stateDir: input.baseDir,
          openWebSessionNames: input.openWebSessionNames,
          ownedProcessRecords: rootDeps.ownedProcessRecords,
        },
      });
    return Object.freeze({
      ...rootDeps,
      ...dependencyOverrides,
      providerDeviceRuntimes: configuredRuntimes,
      deviceRuntimeGateway,
      requestRouter: Object.freeze({
        ...rootDeps.requestRouter,
        ...dependencyOverrides,
        deviceInventoryGateways,
        requestPlatformProviders,
      }),
    }) as DaemonRuntimeDeps;
  };

  let runtime: Awaited<ReturnType<typeof startDaemonRuntime>>;
  try {
    runtime = await startDaemonRuntime({
      env,
      registerProcessHandlers: false,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      exit: () => undefined,
      composeDeps,
    });
  } catch (error) {
    await removeProviderScenarioTempDir(testRoot);
    throw error;
  }
  if (!runtime?.httpPort) {
    await removeProviderScenarioTempDir(testRoot);
    throw new Error('Provider scenario daemon did not start an HTTP server');
  }
  const httpPort = runtime.httpPort;
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const transport: AgentDeviceDaemonTransport = async (request, context) => {
    const wireRequest: DaemonWireRequest = {
      ...request,
      token: context?.authToken ?? runtime.token,
      session: request.session ?? 'default',
    };
    const payload = buildHttpRpcPayload(wireRequest, { includeTokenParam: true });
    const { body } = await postProviderScenarioRpc({
      port: httpPort,
      token: wireRequest.token,
      payload,
      signal: context?.signal,
    });
    return await new Promise<DaemonResponse>((resolve, reject) => {
      handleDaemonHttpResponseBody(body, {
        info: {
          transport: 'http',
          httpPort,
          token: wireRequest.token,
          pid: process.pid,
        },
        req: wireRequest,
        stateDir,
        resolve,
        reject,
      });
    });
  };
  const client = createAgentDeviceClient({ daemonAuthToken: runtime.token }, { transport });
  let closed = false;

  return {
    callCommand: async (command, positionals = [], flags = {}, options = {}) => {
      const request = await withClientReplayScriptSources(
        commandRequest(runtime.token, command, positionals, flags, options),
      );
      const payload = buildHttpRpcPayload(request, { includeTokenParam: true });
      const { statusCode, body } = await postProviderScenarioRpc({
        port: httpPort,
        token: runtime.token,
        payload,
      });
      const envelope = JSON.parse(body) as JsonRpcResponseEnvelope;
      if (envelope.result) assertNoInternalChromeProvenance(envelope.result);
      if (envelope.result) return responseToRpcResult(envelope.result, String(payload.id));
      return {
        statusCode: envelope.error?.code === -32000 ? 200 : statusCode,
        json: {
          jsonrpc: '2.0',
          id: payload.id,
          error: envelope.error ?? { code: statusCode, message: '' },
        },
      };
    },
    client: () => client,
    hasSession: async (name = 'default') =>
      (await client.sessions.list()).some((session) => session.name === name),
    baseUrl,
    httpPort: runtime.httpPort,
    token: runtime.token,
    sessionDir: (name = 'default') => resolveSessionDir(daemonPaths.sessionsDir, name),
    close: async () => {
      if (closed) return;
      closed = true;
      if (scopedAppleToolProvider) {
        const { withAppleToolProvider } =
          await import('@agent-device/platform-apple/tool-provider');
        await withAppleToolProvider(scopedAppleToolProvider, async () => await runtime?.shutdown());
      } else {
        await runtime?.shutdown();
      }
      await removeProviderScenarioTempDir(testRoot);
    },
  };
}

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

  try {
    const requestBody = await readRequestBody(request);
    const entry = recordForwardedRequest(request, target.route, requestBody, forwarded);
    const upstreamResponse = await forwardToDaemon(upstreamPort, request, target.path, requestBody);
    recordUpstreamResponse(entry, upstreamResponse);
    sendUpstreamResponse(response, upstreamResponse);
  } catch (error) {
    response.statusCode = 502;
    response.end(error instanceof Error ? error.message : String(error));
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

async function postProviderScenarioRpc(params: {
  port: number;
  token: string;
  payload: ReturnType<typeof buildHttpRpcPayload>;
  signal?: AbortSignal;
}): Promise<{ statusCode: number; body: string }> {
  const body = JSON.stringify(params.payload);
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: params.port,
        path: '/rpc',
        method: 'POST',
        headers: {
          authorization: `Bearer ${params.token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        signal: params.signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

export async function withProviderScenarioResource<
  TResource extends ClosableProviderScenarioResource,
  TResult,
>(
  create: () => Promise<TResource>,
  run: (resource: TResource) => Promise<TResult> | TResult,
): Promise<TResult> {
  const resource = await create();
  try {
    return await run(resource);
  } finally {
    await resource.close();
  }
}

export function createProviderScenarioTempPath(prefix: string, extension: string): string {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`;
  return path.join(os.tmpdir(), `${prefix}-${suffix}${normalizedExtension}`);
}

export async function withProviderScenarioTempDir<TResult>(
  prefix: string,
  run: (dir: string) => Promise<TResult> | TResult,
): Promise<TResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await removeProviderScenarioTempDir(dir);
  }
}

async function removeProviderScenarioTempDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(dir, PROVIDER_SCENARIO_TEMP_REMOVE_OPTIONS);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code ?? '')) throw error;
      await sleep(50 * (attempt + 1));
    }
  }
}

export { restoreEnv } from '@agent-device/test-kit';

export function likelyPlayableMp4Container(): Buffer {
  return Buffer.concat([atom('ftyp', Buffer.from('isom0000isom')), atom('moov')]);
}

export function createProviderIosSimulatorRecordingProcess(
  outPath: string,
  onSignal?: (signal: NodeJS.Signals | number | undefined) => void,
): AppleSimulatorScreenRecordingProcess {
  fs.writeFileSync(outPath, Buffer.alloc(0));
  const background = runCmdBackground(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', 'provider-screen-recording'],
    { allowFailure: true, captureOutput: false },
  );
  return {
    child: {
      pid: background.child.pid,
      kill: (signal) => {
        onSignal?.(signal);
        fs.writeFileSync(outPath, likelyPlayableMp4Container());
        return background.child.kill(signal);
      },
    },
    wait: background.wait,
  };
}

function atom(type: string, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function commandRequest(
  token: string,
  command: string,
  positionals: string[] = [],
  flags: DaemonWireRequest['flags'] = {},
  options: {
    input?: DaemonWireRequest['input'];
    meta?: DaemonWireRequest['meta'];
    runtime?: DaemonWireRequest['runtime'];
    session?: string;
  } = {},
): DaemonWireRequest {
  return {
    token,
    session: options.session ?? 'default',
    command,
    positionals,
    input: options.input,
    flags,
    runtime: options.runtime,
    meta: options.meta,
  };
}

function responseToRpcResult(response: DaemonResponse, id: string): ProviderScenarioRpcResult {
  return {
    statusCode: 200,
    json: response.ok
      ? {
          jsonrpc: '2.0',
          id,
          result: { data: response.data ?? {} },
        }
      : {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: response.error.message,
            data: response.error,
          },
        },
  };
}

function assertNoInternalChromeProvenance(response: DaemonResponse): void {
  assert.equal(
    JSON.stringify(response).includes('"systemChrome"'),
    false,
    'Public daemon responses must not expose Android-internal systemChrome provenance',
  );
}
