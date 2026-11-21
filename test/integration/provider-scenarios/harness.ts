import { webSelectionFixture } from '../../../src/platform-runtime-web-provider.fixtures.ts';
import { vegaSelectionFixture } from '../../../src/platform-runtime-vega-provider.fixtures.ts';
import { linuxSelectionFixture } from '../../../src/platform-runtime-linux-provider.fixtures.ts';
import { composePlatformPlugins } from '../../../src/platform-runtime/platform-plugins.ts';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAgentDeviceClient } from '@agent-device/client';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import { resolveLocalDaemonCodeIdentity } from '@agent-device/daemon-client';
import type { AppleToolProvider } from '@agent-device/platform-apple/tool-provider';
import {
  startDaemonRuntime,
  type ComposeDaemonRuntimeDeps,
  type DaemonRuntimeDeps,
} from '@agent-device/daemon';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { resolveSessionDir } from '@agent-device/daemon-contracts/session-artifact-paths';
import {
  buildScenarioRpcRequest,
  commandRequest,
  envelopeToRpcResult,
  type JsonRpcResponseEnvelope,
} from './harness-rpc.ts';
import { createDaemonRuntimeDeps } from '../../../src/daemon-composition.ts';
import {
  createPlatformRuntimeGateway,
  createRequestPlatformProviders,
  type PlatformProviderResolvers,
} from '../../../src/platform-runtime.ts';
import type { AppleSimulatorScreenRecordingProcess } from '../../../src/platform-runtime-screen-recording-apple-transport.ts';
import { runCmdBackground, withCommandExecutorOverride } from '@agent-device/host-kit/command';
import { beforeEach, type TestContext } from 'vitest';
import {
  createTestHostEnvironment,
  requireUnsharedTestRunDir,
  unsharedTestRunDir,
} from '@agent-device/test-kit';
import { prepareVideoValidator } from '@agent-device/capture-kit/recording-video';
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
import { createProviderPlatformRuntimeRegistrations } from './provider-platform-registrations.ts';

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
  stateDir: string;
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
    /** Settings the daemon's host reads, on top of the isolated defaults. */
    env?: Readonly<Record<string, string>>;
  };

// The test the harness serves, so a scenario that needs the Swift cache can skip itself from inside a command.
// Each test file evaluates this module on its own, so the hook is registered once per file.
let scenarioTest: TestContext | undefined;
beforeEach((context) => {
  scenarioTest = context;
});

export async function createProviderScenarioHarness(
  deps: ProviderScenarioDependencies,
): Promise<ProviderScenarioHarness> {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-provider-scenario-'));
  // Only a path: the Swift helper cache creates it, privately, the first time a scenario compiles a helper, so a
  // scenario that never does needs nothing from the run's checkout-local directory. That directory is the place
  // the cache accepts, since it refuses a sticky shared one such as /tmp; without it, a compile there is refused.
  const swiftCacheRoot = path.join(
    unsharedTestRunDir() ?? testRoot,
    `provider-scenario-swift-cache-${path.basename(testRoot)}`,
  );
  const removeScenarioDirs = async () => {
    fs.rmSync(swiftCacheRoot, { recursive: true, force: true });
    await removeProviderScenarioTempDir(testRoot);
  };
  const stateDir = path.join(testRoot, 'state');
  const daemonPaths = resolveDaemonPaths(stateDir);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGENT_DEVICE_HOME: process.env.AGENT_DEVICE_HOME,
    TMPDIR: process.env.TMPDIR,
    // A scenario that seeds claims for its daemon names the directory through the process.
    AGENT_DEVICE_CLAIMS_DIR: process.env.AGENT_DEVICE_CLAIMS_DIR ?? path.join(testRoot, 'claims'),
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '3600000',
    AGENT_DEVICE_SWIFT_CACHE_DIR: swiftCacheRoot,
    ...deps.env,
    // Set last: the harness reads its own state dir and transport back from these.
    AGENT_DEVICE_STATE_DIR: stateDir,
    AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
  };
  const {
    deviceInventoryProvider,
    deviceInventorySource,
    deviceRuntimeGateway: configuredDeviceRuntimeGateway,
    platformRuntime,
    providerRuntimes,
    leaseTtlMs,
    env: _env,
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
    // A scenario that resolves a Linux tool provider serves the Linux family through the installed
    // plugin: the selection is what gives the family its runtime and interactor at all, and what
    // lets a request scope a provider for it.
    const linuxSelection = linuxToolProvider
      ? linuxSelectionFixture(input.host, input.baseDir)
      : undefined;
    const platforms = composePlatformPlugins(
      [
        webSelectionFixture(input.host, input.baseDir, {
          openWebSessionNames: input.openWebSessionNames,
          ownedProcessRecords: rootDeps.ownedProcessRecords,
        }).get(),
        vegaSelectionFixture(input.host, input.baseDir).get(),
        ...(linuxSelection ? [linuxSelection.get()] : []),
      ],
      [],
    );
    const { web, vega, linux } = platforms;
    const defaultDeviceRuntimeGateway = createPlatformRuntimeGateway({
      platforms,
      host: input.host,
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
        web,
        vega,
        linux,
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
      host: createTestHostEnvironment({ env }),
      codeIdentity: await resolveLocalDaemonCodeIdentity(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      composeDeps,
    });
  } catch (error) {
    await removeScenarioDirs();
    throw error;
  }
  if (!runtime?.httpPort) {
    await removeScenarioDirs();
    throw new Error('Provider scenario daemon did not start an HTTP server');
  }
  const httpPort = runtime.httpPort;
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  // The production client, attached to the daemon this harness started, over its HTTP endpoint.
  const client = createAgentDeviceClient(
    {
      stateDir,
      daemonLifecycle: 'attach',
      daemonTransport: 'http',
      daemonAuthToken: runtime.token,
    },
    { host: createTestHostEnvironment({ env }) },
  );
  let closed = false;

  return {
    callCommand: async (command, positionals = [], flags = {}, options = {}) => {
      // The validator compiles only on macOS hosts; elsewhere record stop keeps container-only MP4 completion.
      // The warm compile needs the run's checkout-local directory; without one, a scenario that compiles answers
      // for it below, and every other recording scenario runs.
      if (command === 'record' && process.platform === 'darwin' && unsharedTestRunDir()) {
        await withCommandExecutorOverride(
          (command, args) => {
            if (
              command !== '/usr/bin/xcrun' ||
              !args.includes('swiftc') ||
              !args.some((arg) => path.basename(arg).startsWith('video-validator-'))
            )
              return undefined;
            const output = args[args.indexOf('-o') + 1];
            if (!args.includes('-o') || !output)
              throw new Error('Missing validator fixture output');
            fs.writeFileSync(output, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
            return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
          },
          async () => await prepareVideoValidator(createTestHostEnvironment({ env })),
        );
      }
      const request = await withClientReplayScriptSources(
        commandRequest(runtime.token, command, positionals, flags, options),
      );
      const payload = buildScenarioRpcRequest(request, { includeTokenParam: true });
      const { statusCode, body } = await postProviderScenarioRpc({
        port: httpPort,
        token: runtime.token,
        payload,
      });
      const envelope = JSON.parse(body) as JsonRpcResponseEnvelope;
      if (envelope.result) assertNoInternalChromeProvenance(envelope.result);
      const result = envelopeToRpcResult(envelope, payload.id, statusCode);
      // A command that really compiled through the cache, in a run without the checkout-local directory.
      if (
        scenarioTest &&
        !unsharedTestRunDir() &&
        result.json?.error?.data?.details?.reason === 'swift_cache_untrusted'
      ) {
        requireUnsharedTestRunDir(scenarioTest);
      }
      return result;
    },
    client: () => client,
    hasSession: async (name = 'default') =>
      (await client.sessions.list()).some((session) => session.name === name),
    stateDir,
    baseUrl,
    httpPort: runtime.httpPort,
    token: runtime.token,
    sessionDir: (name = 'default') => resolveSessionDir(daemonPaths.sessionsDir, name),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        if (scopedAppleToolProvider) {
          const { withAppleToolProvider } =
            await import('@agent-device/platform-apple/tool-provider');
          await withAppleToolProvider(scopedAppleToolProvider, async () => await runtime?.close());
        } else {
          await runtime?.close();
        }
      } finally {
        await removeScenarioDirs();
      }
    },
  };
}

async function postProviderScenarioRpc(params: {
  port: number;
  token: string;
  payload: ReturnType<typeof buildScenarioRpcRequest>;
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
