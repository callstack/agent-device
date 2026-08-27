import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAgentDeviceClient } from '../../../src/agent-device-client.ts';
import type { AgentDeviceDaemonTransport } from '@agent-device/contracts/client';
import type { AgentDeviceClient } from '../../../src/client/client-types.ts';
import {
  createRequestHandler,
  type RequestRouterDeps,
} from '../../../src/daemon/request-router.ts';
import {
  createPlatformRuntimeGateway,
  createRequestPlatformProviders,
  type PlatformProviderResolvers,
} from '../../../src/platform-runtime.ts';
import type { AppleSimulatorScreenRecordingProcess } from '../../../src/platform-runtime-screen-recording-apple-transport.ts';
import { trackDownloadableArtifact } from '../../../src/daemon/artifact-tracking.ts';
import { LeaseRegistry } from '../../../src/daemon/lease-registry.ts';
import { SessionStore } from '../../../src/daemon/session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../../src/daemon/types.ts';
import { runCmdBackground } from '../../../src/utils/exec.ts';
import { withClientReplayScriptSources } from '../../../src/__tests__/test-utils/replay-script-source.ts';
import type {
  DeviceInventoryProvider,
  ProviderDeviceRuntime,
  ProviderDeviceInventorySource,
} from '@agent-device/contracts/device';
import {
  createTestDeviceInventoryGateways,
  createTestDeviceInventoryGatewaysFromProvider,
} from '../../../src/__tests__/test-utils/device-inventory-gateways.ts';
import { createHostDiagnostics } from '../../../src/platform-runtime-host-diagnostics.ts';
import type { PlatformRuntimeProviderRegistration } from '../../../src/platform-runtime-gateway.ts';
import { createProviderPlatformRuntimeRegistrations } from '../../../src/provider-device-runtimes.ts';
import { unavailableDeviceRuntimeGateway } from '../../../src/daemon/__tests__/test-device-runtime-gateway.ts';
import { createOwnedProcessRecordStore } from '../../../src/utils/owned-process-record.ts';
import { openWebSessionNames } from '../../../src/daemon/web-session-names.ts';

const PROVIDER_SCENARIO_TOKEN = 'provider-scenario-token';
const PROVIDER_SCENARIO_TEMP_REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50,
} as const;

export type ProviderScenarioRpcResult = { statusCode: number; json: any };

export type ProviderScenarioHarness = {
  callCommand: (
    command: string,
    positionals?: string[],
    flags?: DaemonRequest['flags'],
    options?: {
      input?: DaemonRequest['input'];
      meta?: DaemonRequest['meta'];
      runtime?: DaemonRequest['runtime'];
      session?: string;
    },
  ) => Promise<ProviderScenarioRpcResult>;
  client: () => AgentDeviceClient;
  session: (name?: string) => SessionState | undefined;
  sessionDir: (name?: string) => string;
  setSession: (name: string, session: SessionState) => void;
  close: () => Promise<void>;
};

export type ClosableProviderScenarioResource = {
  close: () => Promise<void> | void;
};

export type ProviderScenarioPlatformRuntime =
  | boolean
  | Readonly<{
      providerRuntimes: readonly ProviderDeviceRuntime[];
      providerModules: readonly PlatformRuntimeProviderRegistration[];
    }>;

export async function createProviderScenarioHarness(
  deps: Partial<Omit<RequestRouterDeps, 'deviceInventoryGateways'>> &
    Partial<PlatformProviderResolvers> &
    (
      | { deviceInventoryProvider: DeviceInventoryProvider; deviceInventorySource?: never }
      | { deviceInventorySource: ProviderDeviceInventorySource; deviceInventoryProvider?: never }
    ) & {
      /**
       * Eager provider ownership metadata used only to build explicit provider registrations for
       * a scenario. It is intentionally not forwarded as ambient router policy.
       */
      providerRuntimes?: readonly ProviderDeviceRuntime[];
      platformRuntime?: ProviderScenarioPlatformRuntime;
    },
): Promise<ProviderScenarioHarness> {
  const sessionDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-provider-scenario-session-'),
  );
  const sessionStore = new SessionStore(sessionDir);
  const ownedProcessRecords = createOwnedProcessRecordStore({
    stateDir: path.dirname(sessionDir),
    sessionsDir: sessionDir,
    resolveSessionDir: (sessionId) => sessionStore.resolveSessionDir(sessionId),
  });
  const {
    deviceInventoryProvider,
    deviceInventorySource,
    deviceRuntimeGateway: configuredDeviceRuntimeGateway,
    platformRuntime = true,
    providerRuntimes,
    requestPlatformProviders: configuredRequestPlatformProviders,
    androidAdbProvider,
    appleRunnerProvider,
    appleRunnerScreenRecordingTransport,
    appleToolProvider,
    linuxToolProvider,
    vegaToolProvider,
    webProvider,
    appleSimulatorScreenRecordingTransport,
    ...routerDeps
  } = deps;
  const platformRuntimeOptions =
    typeof platformRuntime === 'object'
      ? platformRuntime
      : {
          // Provider runtime mechanics remain implementation-lazy, but their owner metadata is
          // present before the first facts admission. This matches daemon composition and makes
          // a missing provider module fail closed instead of falling back to host tooling.
          providerRuntimes: providerRuntimes ?? [],
          providerModules: createProviderPlatformRuntimeRegistrations(providerRuntimes ?? []),
        };
  const deviceRuntimeGateway =
    configuredDeviceRuntimeGateway ??
    (platformRuntime
      ? createPlatformRuntimeGateway({
          ...platformRuntimeOptions,
          sessionsDir: sessionDir,
          ownedProcesses: ownedProcessRecords,
          resolveSessionArtifacts: (sessionId) => ({
            outputPath: sessionStore.resolveAppLogPath(sessionId),
            pidPath: sessionStore.resolveAppLogPidPath(sessionId),
          }),
        })
      : unavailableDeviceRuntimeGateway);
  const requestHandler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'agent-device-provider-scenario-daemon.log'),
    token: PROVIDER_SCENARIO_TOKEN,
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: deviceInventorySource
      ? createTestDeviceInventoryGateways({ provider: deviceInventorySource })
      : createTestDeviceInventoryGatewaysFromProvider(deviceInventoryProvider),
    deviceRuntimeGateway,
    trackDownloadableArtifact,
    // Match daemon composition (src/daemon/server/daemon-runtime.ts): doctor's host-scoped
    // diagnostics are injected at the root, so the harness composes them the same way.
    hostDiagnostics: createHostDiagnostics(),
    requestPlatformProviders:
      configuredRequestPlatformProviders ??
      createRequestPlatformProviders({
        providers: {
          androidAdbProvider,
          appleRunnerProvider,
          appleRunnerScreenRecordingTransport,
          appleToolProvider,
          linuxToolProvider,
          vegaToolProvider,
          webProvider,
          appleSimulatorScreenRecordingTransport,
        },
        defaultWebProvider: {
          stateDir: path.dirname(sessionDir),
          openWebSessionNames: () => openWebSessionNames(sessionStore),
          ownedProcessRecords,
        },
      }),
    ...routerDeps,
  });
  const handleRequest: typeof requestHandler = async (request) => {
    // #1802: a raw `callCommand('replay', [path])` stands in for a client request, and every
    // request that reaches a daemon carries the script sources the CLIENT read.
    const response = await requestHandler(await withClientReplayScriptSources(request));
    assertNoInternalChromeProvenance(response);
    return response;
  };

  const transport: AgentDeviceDaemonTransport = async (req) =>
    await handleRequest({
      token: PROVIDER_SCENARIO_TOKEN,
      session: req.session ?? 'default',
      command: req.command,
      positionals: req.positionals,
      input: req.input,
      flags: req.flags,
      runtime: req.runtime,
      meta: req.meta as DaemonRequest['meta'],
    });

  return {
    callCommand: async (command, positionals = [], flags = {}, options = {}) =>
      responseToRpcResult(
        await handleRequest(commandRequest(command, positionals, flags, options)),
        `direct-${command}-${Date.now()}`,
      ),
    client: () => createAgentDeviceClient({}, { transport }),
    session: (name = 'default') => sessionStore.get(name),
    sessionDir: (name = 'default') => sessionStore.resolveSessionDir(name),
    setSession: (name, session) => sessionStore.set(name, session),
    close: async () => {
      await deviceRuntimeGateway.shutdown();
      await removeProviderScenarioTempDir(sessionDir);
    },
  };
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

export function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

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
  command: string,
  positionals: string[] = [],
  flags: DaemonRequest['flags'] = {},
  options: {
    input?: DaemonRequest['input'];
    meta?: DaemonRequest['meta'];
    runtime?: DaemonRequest['runtime'];
    session?: string;
  } = {},
): DaemonRequest {
  return {
    token: PROVIDER_SCENARIO_TOKEN,
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
