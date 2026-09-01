import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDaemonHttpBaseUrl } from '../../src/daemon/http-contract.ts';
import {
  BenchmarkCellAdmissionError,
  BenchmarkContentionError,
  BenchmarkInfrastructureError,
} from './lifecycle.ts';
import {
  classifyFailure,
  closeSessionAsync,
  formatCliFailure,
  type CliContext,
  type CliResult,
} from './command.ts';
import {
  fixtureOperationFromClient,
  prepareFixture,
  requireFixtureAnchor,
} from './fixture-admission.ts';
import { type NetworkConditioner, type ProxyRpcRecord } from './proxy-conditioner.ts';
import type { ProxyStartup } from './proxy-process.ts';
import { asRecord } from './result-values.ts';
import type { Failure, ProxyNetwork, RawSample, ScreenFixture } from './types.ts';

export type AgentClient = {
  apps: { open(options: Record<string, unknown>): Promise<unknown> };
  interactions: {
    click(options: Record<string, unknown>): Promise<unknown>;
    scroll(options: Record<string, unknown>): Promise<unknown>;
  };
  batch: { run(options: Record<string, unknown>): Promise<Record<string, unknown>> };
  sessions: { close(): Promise<unknown> };
  leases: {
    allocate(options: Record<string, unknown>): Promise<Record<string, unknown>>;
    release(options: Record<string, unknown>): Promise<unknown>;
  };
};

type BuiltAgentDeviceSdk = typeof import('../../src/sdk/index.ts');

export type ProxyClientOptions = {
  repoRoot: string;
  clientStateDir: string;
  derivedPath: string;
  udid: string;
  proxy: ProxyStartup;
  conditioner: NetworkConditioner;
};

export async function allocateLease(
  options: Pick<ProxyClientOptions, 'repoRoot' | 'udid' | 'proxy' | 'conditioner'>,
  clientId: string,
  runId: string,
): Promise<Record<string, unknown>> {
  const createAgentDeviceClient = await loadBuiltClient(options.repoRoot);
  const client = createAgentDeviceClient({
    daemonBaseUrl: buildDaemonHttpBaseUrl(options.conditioner.baseUrl),
    daemonAuthToken: options.proxy.token,
    daemonTransport: 'http',
    session: `lease-${clientId}`,
    tenant: 'bench',
    runId,
    leaseProvider: 'proxy',
    clientId,
    leaseBackend: 'ios-simulator',
  });
  return client.leases.allocate({
    tenant: 'bench',
    runId,
    leaseProvider: 'proxy',
    clientId,
    leaseBackend: 'ios-simulator',
    platform: 'ios',
    target: 'mobile',
    udid: options.udid,
    deviceKey: `ios:mobile:${options.udid}`,
  });
}

export async function createClient(
  options: Pick<ProxyClientOptions, 'repoRoot' | 'clientStateDir' | 'proxy' | 'conditioner'>,
  lease: Record<string, unknown>,
  clientId: string,
  runId: string,
  suffix: string,
): Promise<AgentClient> {
  const createAgentDeviceClient = await loadBuiltClient(options.repoRoot);
  return createAgentDeviceClient({
    stateDir: path.join(options.clientStateDir, suffix),
    daemonBaseUrl: buildDaemonHttpBaseUrl(options.conditioner.baseUrl),
    daemonAuthToken: options.proxy.token,
    daemonTransport: 'http',
    session: clientId,
    tenant: 'bench',
    runId,
    leaseProvider: 'proxy',
    clientId,
    leaseBackend: 'ios-simulator',
    leaseId: readRequiredString(lease, 'leaseId'),
    deviceKey: readRequiredString(lease, 'deviceKey'),
  });
}

export async function openClientFixture(
  client: AgentClient,
  fixture: ScreenFixture,
  udid: string,
): Promise<void> {
  await client.apps.open({
    app: fixture.app,
    ...(fixture.launchUrl ? { url: fixture.launchUrl } : {}),
    platform: 'ios',
    udid,
    relaunch: true,
    foreground: true,
  });
  await prepareFixture(fixture, {
    observe: async () =>
      fixtureOperationFromClient(
        await client.batch.run(snapshotBatchOptions()),
        'agent-device client batch --steps snapshot',
      ),
    scrollToBottom: async () =>
      fixtureOperationFromClient(
        await client.interactions.scroll({
          direction: 'bottom',
          platform: 'ios',
          udid,
        }),
        'agent-device client scroll bottom',
      ),
    openAlert: async () =>
      fixtureOperationFromClient(
        await client.interactions.click({
          target: { kind: 'selector', selector: 'id="automation-open-alert"' },
          platform: 'ios',
          udid,
        }),
        'agent-device client click id="automation-open-alert"',
      ),
  });
}

export async function captureClientSample(
  client: AgentClient,
  options: Pick<ProxyClientOptions, 'conditioner'> & {
    fixture: ScreenFixture;
    network: ProxyNetwork;
  },
  index: number,
): Promise<RawSample> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const mark = options.conditioner.mark();
  try {
    const result = await client.batch.run({
      steps: [{ command: 'snapshot', input: { interactiveOnly: true } }],
    });
    const record = lastRecord(options.conditioner.recordsSince(mark));
    return buildSuccessfulClientSample(
      result,
      options.fixture,
      options.network,
      record,
      index,
      startedAt,
      started,
    );
  } catch (error) {
    if (error instanceof BenchmarkCellAdmissionError) throw error;
    const record = lastRecord(options.conditioner.recordsSince(mark));
    return buildFailedClientSample(options.network, record, error, index, startedAt, started);
  }
}

function buildSuccessfulClientSample(
  result: Record<string, unknown>,
  fixture: ScreenFixture,
  network: ProxyNetwork,
  record: ProxyRpcRecord | undefined,
  index: number,
  startedAt: string,
  started: number,
): RawSample {
  const first = firstClientResult(result);
  const snapshot = snapshotFromClientResult(first);
  const nodeCount = readNodeCount(snapshot);
  const succeeded = clientSampleSucceeded(record);
  if (succeeded) {
    requireFixtureAnchor(result, fixture, 'sample', 'agent-device client batch --steps snapshot');
  }
  return {
    ...sampleTiming(index, startedAt, started),
    ...daemonDurationFields(first),
    ...responseFields(record),
    ...nodeFields(nodeCount),
    targetGeneration: targetGeneration(snapshot),
    firstTree: firstTreeForClient(nodeCount),
    ok: succeeded,
    outlier: false,
    ...clientFailureFields(network, record),
  };
}

function firstClientResult(result: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(result.results?.[0]);
}

function snapshotFromClientResult(
  first: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const data = asRecord(first?.data);
  return snapshotFromData(data);
}

function snapshotFromData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asRecord(data?.snapshot) ?? data;
}

function daemonDurationFields(first: Record<string, unknown> | undefined): {
  daemonDurationMs?: number;
} {
  return typeof first?.durationMs === 'number' ? { daemonDurationMs: first.durationMs } : {};
}

function targetGeneration(snapshot: Record<string, unknown> | undefined): number | null {
  return readNumber(snapshot?.refsGeneration) ?? null;
}

function clientSampleSucceeded(record: ProxyRpcRecord | undefined): boolean {
  return record?.failed !== true;
}

function buildFailedClientSample(
  network: ProxyNetwork,
  record: ProxyRpcRecord | undefined,
  error: unknown,
  index: number,
  startedAt: string,
  started: number,
): RawSample {
  return {
    ...sampleTiming(index, startedAt, started),
    ...responseFields(record),
    targetGeneration: null,
    firstTree: 'not-observed',
    ok: false,
    outlier: false,
    failure: {
      ...networkFailure(network, record?.failed),
      ...(error instanceof Error ? { message: error.message.slice(0, 240) } : {}),
    },
  };
}

function sampleTiming(
  index: number,
  startedAt: string,
  started: number,
): Pick<RawSample, 'index' | 'startedAt' | 'finishedAt' | 'operation' | 'wallClockMs'> {
  return {
    index: index + 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    operation: 'snapshot',
    wallClockMs: performance.now() - started,
  };
}

function responseFields(record: ProxyRpcRecord | undefined): { responseBytes?: number } {
  return record ? { responseBytes: record.responseBytes } : {};
}

function nodeFields(nodeCount: number | undefined): { nodeCount?: number } {
  return nodeCount === undefined ? {} : { nodeCount };
}

function readNodeCount(snapshot: Record<string, unknown> | undefined): number | undefined {
  const nodes = snapshot?.nodes;
  return Array.isArray(nodes) ? nodes.length : undefined;
}

function firstTreeForClient(nodeCount: number | undefined): RawSample['firstTree'] {
  if (nodeCount === undefined) return 'not-observed';
  return nodeCount === 0 ? 'empty' : 'readable';
}

function clientFailureFields(
  network: ProxyNetwork,
  record: ProxyRpcRecord | undefined,
): { failure?: Failure } {
  return record?.failed ? { failure: networkFailure(network) } : {};
}

export async function closeClient(client: AgentClient): Promise<void> {
  try {
    await client.sessions.close();
  } catch {
    return;
  }
}

export async function releaseLease(
  options: Pick<ProxyClientOptions, 'repoRoot' | 'proxy' | 'conditioner'>,
  lease: Record<string, unknown>,
  clientId: string,
  runId: string,
): Promise<void> {
  try {
    const createAgentDeviceClient = await loadBuiltClient(options.repoRoot);
    const client = createAgentDeviceClient({
      daemonBaseUrl: buildDaemonHttpBaseUrl(options.conditioner.baseUrl),
      daemonAuthToken: options.proxy.token,
      daemonTransport: 'http',
      session: `release-${clientId}`,
      tenant: 'bench',
      runId,
      leaseProvider: 'proxy',
      clientId,
      leaseBackend: 'ios-simulator',
      leaseId: readRequiredString(lease, 'leaseId'),
      deviceKey: readRequiredString(lease, 'deviceKey'),
    });
    await client.leases.release({
      tenant: 'bench',
      runId,
      leaseId: readRequiredString(lease, 'leaseId'),
      leaseProvider: 'proxy',
      clientId,
      leaseBackend: 'ios-simulator',
      deviceKey: readRequiredString(lease, 'deviceKey'),
    });
  } catch {
    return;
  }
}

async function loadBuiltClient(
  repoRoot: string,
): Promise<BuiltAgentDeviceSdk['createAgentDeviceClient']> {
  const module = (await import(
    pathToFileURL(path.resolve(repoRoot, 'dist/src/index.js')).href
  )) as BuiltAgentDeviceSdk;
  return module.createAgentDeviceClient;
}

export function remoteFlags(
  options: Pick<ProxyClientOptions, 'proxy' | 'conditioner'>,
  lease: Record<string, unknown>,
  clientId: string,
  runId: string,
  stateDir: string,
): string[] {
  const remoteConfigPath = path.join(stateDir, 'proxy-connection.json');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    remoteConfigPath,
    `${JSON.stringify(
      {
        daemonBaseUrl: buildDaemonHttpBaseUrl(options.conditioner.baseUrl),
        daemonTransport: 'http',
        tenant: 'bench',
        sessionIsolation: 'tenant',
        runId,
        leaseId: readRequiredString(lease, 'leaseId'),
        leaseBackend: 'ios-simulator',
        leaseProvider: 'proxy',
        clientId,
        deviceKey: readRequiredString(lease, 'deviceKey'),
        platform: 'apple',
        target: 'mobile',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return [
    '--daemon-base-url',
    buildDaemonHttpBaseUrl(options.conditioner.baseUrl),
    '--daemon-auth-token',
    options.proxy.token,
    '--daemon-transport',
    'http',
    '--platform',
    'apple',
    '--remote-config',
    remoteConfigPath,
  ];
}

export async function closeCliSession(context: CliContext): Promise<void> {
  await closeSessionAsync(context);
}

export function setupFailure(operation: string, result: CliResult): BenchmarkInfrastructureError {
  const failure = classifyFailure(result.payload, result);
  const message = formatCliFailure(operation, failure, result);
  if (failure.code === 'DEVICE_IN_USE') throw new BenchmarkContentionError(message, operation);
  return new BenchmarkInfrastructureError(message, operation);
}

function networkFailure(network: ProxyNetwork, failed = true): Failure {
  return {
    category: failed && network.packetLossPercent > 0 ? 'packet-loss' : 'upstream',
  };
}

function lastRecord(records: ProxyRpcRecord[]): ProxyRpcRecord | undefined {
  return records.at(-1);
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || result.length === 0) {
    throw new BenchmarkInfrastructureError(`Lease did not contain ${key}.`);
  }
  return result;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function snapshotBatchOptions(): Record<string, unknown> {
  return { steps: [{ command: 'snapshot', input: { interactiveOnly: true } }] };
}
