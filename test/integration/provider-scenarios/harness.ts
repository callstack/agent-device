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
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { resolveSessionDir } from '@agent-device/daemon-contracts/session-artifact-paths';
import {
  buildHttpRpcPayload,
  handleDaemonHttpResponseBody,
} from '../../../src/daemon-client/daemon-client-rpc.ts';
import { commandRequest, responseToRpcResult } from './harness-rpc.ts';
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
import type { PlatformRuntimeProviderRegistration } from '../../../src/platform-runtime-gateway.ts';
import { createProviderPlatformRuntimeRegistrations } from '../../../src/provider-device-runtimes.ts';

const PROVIDER_SCENARIO_TEMP_REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50,
} as const;

export type ProviderScenarioRpcResult = { statusCode: number; json: any };

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

function assertNoInternalChromeProvenance(response: DaemonResponse): void {
  assert.equal(
    JSON.stringify(response).includes('"systemChrome"'),
    false,
    'Public daemon responses must not expose Android-internal systemChrome provenance',
  );
}
