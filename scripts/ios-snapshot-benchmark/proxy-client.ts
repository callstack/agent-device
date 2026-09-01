import path from 'node:path';
import {
  openFixtureAsync,
  pressFixtureTargetAsync,
  sampleFromCli,
  scrollFixtureSetupAsync,
  snapshotFixtureAsync,
} from './command.ts';
import { buildMeasurement } from './statistics.ts';
import {
  fixtureOperationFromCli,
  prepareFixture,
  requireFixtureAnchor,
} from './fixture-admission.ts';
import {
  allocateLease,
  captureClientSample,
  closeCliSession,
  closeClient,
  createClient,
  openClientFixture,
  releaseLease,
  remoteFlags,
  setupFailure,
  type AgentClient,
} from './proxy-client-support.ts';
import type { NetworkConditioner } from './proxy-conditioner.ts';
import type { ProxyStartup } from './proxy-process.ts';
import type { Measurement, ProxyNetwork, RawSample, ScreenFixture } from './types.ts';

export type ProxyMeasurementOptions = {
  repoRoot: string;
  clientStateDir: string;
  derivedPath: string;
  udid: string;
  samples: number;
  fixture: ScreenFixture;
  network: ProxyNetwork;
  proxy: ProxyStartup;
  conditioner: NetworkConditioner;
};

export async function runPersistentMeasurement(
  options: ProxyMeasurementOptions,
): Promise<Measurement> {
  const { clientId, runId } = measurementIdentity(options, 'persistent');
  const lease = await allocateLease(options, clientId, runId);
  let client: AgentClient | undefined;
  const samples: RawSample[] = [];
  try {
    client = await createClient(options, lease, clientId, runId, 'persistent');
    await openClientFixture(client, options.fixture, options.udid);
    for (let index = 0; index < options.samples; index += 1) {
      samples.push(await captureClientSample(client, options, index));
    }
  } finally {
    if (client) await closeClient(client);
    await releaseLease(options, lease, clientId, runId);
  }
  return buildMeasurement({
    transport: 'proxy',
    execution: 'persistent-client',
    state: 'warm',
    screen: options.fixture.id,
    sampleMinimum: options.samples >= 20 ? 20 : 10,
    operation: 'snapshot',
    samples,
    network: options.network,
  });
}

export async function runFreshCliMeasurement(
  options: ProxyMeasurementOptions,
): Promise<Measurement> {
  const { clientId, runId } = measurementIdentity(options, 'cli');
  const lease = await allocateLease(options, clientId, runId);
  try {
    return await measureFreshCli(options, lease, clientId, runId);
  } finally {
    await releaseLease(options, lease, clientId, runId);
  }
}

async function measureFreshCli(
  options: ProxyMeasurementOptions,
  lease: Record<string, unknown>,
  clientId: string,
  runId: string,
): Promise<Measurement> {
  const context = freshCliContext(options, lease, clientId, runId);
  try {
    const samples = await collectFreshCliSamples(context, options);
    return buildMeasurement({
      transport: 'proxy',
      execution: 'fresh-process-cli',
      state: 'warm',
      screen: options.fixture.id,
      sampleMinimum: options.samples >= 20 ? 20 : 10,
      operation: 'snapshot',
      samples,
      network: options.network,
    });
  } finally {
    await closeCliSession(context);
  }
}

function freshCliContext(
  options: ProxyMeasurementOptions,
  lease: Record<string, unknown>,
  clientId: string,
  runId: string,
) {
  const stateDir = path.join(
    options.clientStateDir,
    `cli-${options.fixture.id}-${options.network.rttMs}`,
  );
  return {
    repoRoot: options.repoRoot,
    stateDir,
    session: `bench-cli-${options.fixture.id}-${options.network.rttMs}`,
    udid: options.udid,
    derivedPath: options.derivedPath,
    extraFlags: remoteFlags(options, lease, clientId, runId, stateDir),
  };
}

async function collectFreshCliSamples(
  context: ReturnType<typeof freshCliContext>,
  options: ProxyMeasurementOptions,
): Promise<RawSample[]> {
  const opened = await openFixtureAsync(context, options.fixture, { relaunch: true });
  if (!opened.ok) throw setupFailure('fresh CLI open', opened);
  await prepareFreshCliFixture(context, options.fixture);
  const samples: RawSample[] = [];
  for (let index = 0; index < options.samples; index += 1) {
    const mark = options.conditioner.mark();
    const result = await snapshotFixtureAsync(context);
    if (result.ok) {
      requireFixtureAnchor(
        result.payload,
        options.fixture,
        'sample',
        'agent-device batch --steps snapshot',
      );
    }
    samples.push(sampleFromProxyCli(result, options.conditioner, mark, index));
  }
  return samples;
}

async function prepareFreshCliFixture(
  context: ReturnType<typeof freshCliContext>,
  fixture: ScreenFixture,
): Promise<void> {
  await prepareFixture(fixture, {
    observe: async () =>
      fixtureOperationFromCli(
        await snapshotFixtureAsync(context),
        'agent-device batch --steps snapshot',
      ),
    scrollToBottom: async () =>
      fixtureOperationFromCli(await scrollFixtureSetupAsync(context), 'agent-device scroll bottom'),
    openAlert: async () =>
      fixtureOperationFromCli(
        await pressFixtureTargetAsync(context, 'id="automation-open-alert"'),
        'agent-device click id="automation-open-alert"',
      ),
  });
}

function sampleFromProxyCli(
  result: Awaited<ReturnType<typeof snapshotFixtureAsync>>,
  conditioner: NetworkConditioner,
  mark: number,
  index: number,
): RawSample {
  const record = conditioner.recordsSince(mark).at(-1);
  return {
    ...sampleFromCli(result, 'snapshot', index, record?.responseBytes),
  };
}

function measurementIdentity(
  options: Pick<ProxyMeasurementOptions, 'fixture' | 'network'>,
  kind: 'persistent' | 'cli',
): { clientId: string; runId: string } {
  return {
    clientId: `bench-${kind}-${options.fixture.id}-${options.network.rttMs}`,
    runId: `bench-${options.fixture.id}-${options.network.rttMs}-${kind}`,
  };
}
