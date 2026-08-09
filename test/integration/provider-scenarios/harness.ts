import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentDeviceClient } from '../../../src/agent-device-client.ts';
import type { AgentDeviceDaemonTransport } from '@agent-device/contracts/client';
import type { AgentDeviceClient } from '../../../src/client/client-types.ts';
import {
  createRequestHandler,
  type RequestRouterDeps,
} from '../../../src/daemon/request-router.ts';
import type { RecordingProcess } from '../../../src/daemon/recording-provider.ts';
import { trackDownloadableArtifact } from '../../../src/daemon/artifact-tracking.ts';
import { LeaseRegistry } from '../../../src/daemon/lease-registry.ts';
import { SessionStore } from '../../../src/daemon/session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../../src/daemon/types.ts';
import type { ExecResult } from '../../../src/utils/exec.ts';
import type {
  DeviceInventoryProvider,
  ProviderDeviceInventorySource,
} from '@agent-device/contracts/device';
import {
  createTestDeviceInventoryGateways,
  createTestDeviceInventoryGatewaysFromProvider,
} from '../../../src/__tests__/test-utils/device-inventory-gateways.ts';

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
  setSession: (name: string, session: SessionState) => void;
  close: () => Promise<void>;
};

export type ClosableProviderScenarioResource = {
  close: () => Promise<void> | void;
};

export async function createProviderScenarioHarness(
  deps: Partial<Omit<RequestRouterDeps, 'deviceInventoryGateways'>> &
    (
      | { deviceInventoryProvider: DeviceInventoryProvider; deviceInventorySource?: never }
      | { deviceInventorySource: ProviderDeviceInventorySource; deviceInventoryProvider?: never }
    ),
): Promise<ProviderScenarioHarness> {
  const sessionDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-provider-scenario-session-'),
  );
  const sessionStore = new SessionStore(sessionDir);
  const { deviceInventoryProvider, deviceInventorySource, ...routerDeps } = deps;
  const requestHandler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'agent-device-provider-scenario-daemon.log'),
    token: PROVIDER_SCENARIO_TOKEN,
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: deviceInventorySource
      ? createTestDeviceInventoryGateways({ provider: deviceInventorySource })
      : createTestDeviceInventoryGatewaysFromProvider(deviceInventoryProvider),
    trackDownloadableArtifact,
    ...routerDeps,
  });
  const handleRequest: typeof requestHandler = async (request) => {
    const response = await requestHandler(request);
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
    setSession: (name, session) => sessionStore.set(name, session),
    close: async () => {
      removeProviderScenarioTempDir(sessionDir);
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
    removeProviderScenarioTempDir(dir);
  }
}

function removeProviderScenarioTempDir(dir: string): void {
  fs.rmSync(dir, PROVIDER_SCENARIO_TEMP_REMOVE_OPTIONS);
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
): RecordingProcess {
  fs.writeFileSync(outPath, Buffer.alloc(0));
  let resolveWait: ((result: ExecResult) => void) | undefined;
  const wait = new Promise<ExecResult>((resolve) => {
    resolveWait = resolve;
  });
  return {
    child: {
      kill: (signal) => {
        onSignal?.(signal);
        fs.writeFileSync(outPath, likelyPlayableMp4Container());
        resolveWait?.({ stdout: '', stderr: '', exitCode: 0 });
        return true;
      },
    },
    wait,
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
