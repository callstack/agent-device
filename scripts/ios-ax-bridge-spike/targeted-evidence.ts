import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createGuestSimulatorFrameworkBridgeAdapter } from './guest-adapter.ts';
import type { SpikeConfig } from './config.ts';
import {
  bootSimulator,
  readRunningAppPids,
  shutdownSimulator,
  terminateApp,
} from '../ios-snapshot-benchmark/lifecycle.ts';
import type { SpikeRequest, SpikeResponse } from './types.ts';
import type {
  HostLoad,
  TargetedBootstrapSample,
  TargetedRecoveryProbe,
} from './corrected-types.ts';

const APP_ID = 'com.callstack.agentdevicelab';
const BOOTSTRAP_SAMPLES = 5;
const READINESS_POLL_MS = 200;
const READINESS_DEADLINE_MS = 90_000;
/** Fixture-owned time: the readiness probe may wait for a slow host without shaping the timed sample. */
const READINESS_PROBE_REQUEST_MS = 60_000;

type GuestAdapter = ReturnType<typeof createGuestSimulatorFrameworkBridgeAdapter>;

export type TargetedRunResult = Readonly<{
  bootstrap: readonly TargetedBootstrapSample[];
  recovery: readonly TargetedRecoveryProbe[];
  host: HostLoad;
}>;

/**
 * Live nonresident-bootstrap and recovery evidence for the guest bridge.
 *
 * Boundary: the Simulator is booted and the fixture app is relaunched for every bootstrap sample.
 * App readiness is *observed*, not assumed from a pid: a throwaway probe bridge polls until the new
 * app generation answers with a tree, then is torn down, so the timed sample starts with no resident
 * bridge and a ready app. Automation mode is asserted per request by the guest.
 */
export async function runTargetedEvidence(config: SpikeConfig): Promise<TargetedRunResult> {
  bootSimulator(config.udid);
  try {
    const bootstrap = await runNonresidentBootstrap(config);
    return {
      bootstrap,
      recovery: await runLiveRecovery(config, bootstrap),
      host: hostLoad(),
    };
  } finally {
    if (!config.keepDevice) shutdownSimulator(config.udid);
  }
}

async function runNonresidentBootstrap(
  config: SpikeConfig,
): Promise<readonly TargetedBootstrapSample[]> {
  const samples: TargetedBootstrapSample[] = [];
  for (let index = 1; index <= BOOTSTRAP_SAMPLES; index += 1) {
    samples.push(await captureBootstrap(config, index));
  }
  return samples;
}

async function captureBootstrap(
  config: SpikeConfig,
  index: number,
): Promise<TargetedBootstrapSample> {
  const appPid = await relaunchApp(config.udid);
  const readiness = await awaitAppReadiness(config, appPid);
  await assertNoResidentGuest();
  const adapter = createGuestSimulatorFrameworkBridgeAdapter(adapterOptions(config));
  const started = performance.now();
  const result = await adapter.acquireBatch([
    request(config, `bootstrap-${index}`, {
      expectedTargetGeneration: `pid:${appPid}`,
    }),
  ]);
  const durationMs = performance.now() - started;
  await adapter.close?.();
  const response = result.responses[0] ?? failedResponse(`bootstrap-${index}`);
  return {
    index,
    durationMs,
    usableTree: usableTree(response),
    response,
    stderr: result.stderr,
    appPid,
    readinessMs: readiness.readinessMs,
    readinessAttempts: readiness.attempts,
    host: hostLoad(),
  };
}

/** Polls a throwaway bridge until the new app generation answers with a tree, then tears it down. */
async function awaitAppReadiness(
  config: SpikeConfig,
  appPid: number,
): Promise<{ readinessMs: number; attempts: number }> {
  const probeLimits = { ...config.limits, maxDurationMs: READINESS_PROBE_REQUEST_MS };
  const probe = createGuestSimulatorFrameworkBridgeAdapter({
    ...adapterOptions(config),
    limits: probeLimits,
  });
  const started = performance.now();
  let attempts = 0;
  try {
    for (;;) {
      assertInsideReadinessDeadline(started, appPid);
      attempts += 1;
      if (await probeReadiness(config, probe, probeLimits, appPid, attempts)) {
        return { readinessMs: performance.now() - started, attempts };
      }
      await sleep(READINESS_POLL_MS);
    }
  } finally {
    await probe.close?.();
  }
}

async function probeReadiness(
  config: SpikeConfig,
  probe: GuestAdapter,
  limits: SpikeConfig['limits'],
  appPid: number,
  attempts: number,
): Promise<boolean> {
  const result = await probe.acquireBatch([
    request(config, `readiness-${appPid}-${attempts}`, {
      expectedTargetGeneration: `pid:${appPid}`,
      limits,
    }),
  ]);
  return usableTree(result.responses[0] ?? failedResponse('readiness'));
}

function assertInsideReadinessDeadline(started: number, appPid: number): void {
  if (performance.now() - started < READINESS_DEADLINE_MS) return;
  throw new Error(`App ${APP_ID} (pid ${appPid}) did not expose a readable tree in time.`);
}

/** A killed guest can linger for a moment while launchd_sim reaps it; wait briefly, then fail closed. */
async function assertNoResidentGuest(): Promise<void> {
  const deadline = Date.now() + 5_000;
  let found = residentGuestPids();
  while (found.length > 0 && Date.now() < deadline) {
    await sleep(100);
    found = residentGuestPids();
  }
  if (found.length > 0) {
    throw new Error(`A guest bridge is still resident before a nonresident sample: pids ${found}`);
  }
}

function residentGuestPids(): number[] {
  return execFileSync(
    'sh',
    ['-c', 'pgrep -f "SimulatorFrameworkBridge accessibility serve" || true'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

async function runLiveRecovery(
  config: SpikeConfig,
  bootstrap: readonly TargetedBootstrapSample[],
): Promise<readonly TargetedRecoveryProbe[]> {
  const adapter = createGuestSimulatorFrameworkBridgeAdapter(adapterOptions(config));
  try {
    const probes: TargetedRecoveryProbe[] = [];
    await adapter.acquireBatch([request(config, 'recovery-prime')]);
    adapter.evidence?.terminateReaderOnNextBatch?.();
    probes.push(
      await recoveryProbe(config, adapter, 'process-crash', request(config, 'recovery-crash')),
    );
    probes.push(
      await recoveryProbe(
        config,
        adapter,
        'timeout',
        request(config, 'recovery-timeout', {
          limits: { ...config.limits, maxDurationMs: 1 },
        }),
      ),
    );
    probes.push(await cancellationProbe(config, adapter));
    probes.push(
      await recoveryProbe(
        config,
        adapter,
        'stale-generation',
        request(config, 'recovery-stale-generation', {
          expectedTargetGeneration: `pid:${deadGeneration(bootstrap)}`,
        }),
      ),
    );
    return probes;
  } finally {
    await adapter.close?.();
  }
}

/** A previous app generation's pid: the bootstrap relaunches guarantee it is dead. */
function deadGeneration(bootstrap: readonly TargetedBootstrapSample[]): number {
  const previous = bootstrap.at(-2)?.appPid;
  if (previous === undefined) throw new Error('No previous app generation to test staleness.');
  return previous;
}

async function recoveryProbe(
  config: SpikeConfig,
  adapter: GuestAdapter,
  operation: TargetedRecoveryProbe['operation'],
  probeRequest: SpikeRequest,
): Promise<TargetedRecoveryProbe> {
  const result = await adapter.acquireBatch([probeRequest]);
  return {
    operation,
    request: probeRequest,
    response: result.responses[0] ?? failedResponse(probeRequest.id),
    recoveredResponse: await healthyResponse(config, adapter, `${probeRequest.id}-recovered`),
  };
}

async function cancellationProbe(
  config: SpikeConfig,
  adapter: GuestAdapter,
): Promise<TargetedRecoveryProbe> {
  const probeRequest = request(config, 'recovery-cancelled');
  const controller = new AbortController();
  const pending = adapter.acquireBatch([probeRequest], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 1);
  const result = await pending;
  return {
    operation: 'cancelled',
    request: probeRequest,
    response: result.responses[0] ?? failedResponse(probeRequest.id),
    recoveredResponse: await healthyResponse(config, adapter, 'recovery-cancelled-recovered'),
  };
}

async function healthyResponse(
  config: SpikeConfig,
  adapter: GuestAdapter,
  id: string,
): Promise<SpikeResponse> {
  const result = await adapter.acquireBatch([request(config, id)]);
  return result.responses[0] ?? failedResponse(id);
}

function request(
  config: SpikeConfig,
  id: string,
  overrides: Partial<SpikeRequest> = {},
): SpikeRequest {
  return {
    version: 1,
    id,
    candidate: 'guest-simulator-framework-bridge',
    simulatorUdid: config.udid,
    state: 'warm',
    screen: 'list',
    limits: config.limits,
    ...overrides,
  };
}

function failedResponse(id: string): SpikeResponse {
  return {
    version: 1,
    id,
    candidate: 'guest-simulator-framework-bridge',
    ok: false,
    failure: { kind: 'transport-failure', code: 'missing-response' },
    metrics: {
      requestBytes: 0,
      responseBytes: 0,
      nodeCount: 0,
      maxTraversalDepth: 0,
      cpuMs: null,
      memoryBytes: null,
      durationMs: 0,
    },
  };
}

function usableTree(response: SpikeResponse): boolean {
  return (
    response.ok === true &&
    response.acquisition !== undefined &&
    response.acquisition.nodes.length > 0
  );
}

/** A fresh app generation: terminate, launch, and wait for exactly one running pid. */
async function relaunchApp(udid: string): Promise<number> {
  terminateApp(udid, APP_ID);
  execFileSync('xcrun', ['simctl', 'launch', udid, APP_ID], {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pids = readRunningAppPids(udid, APP_ID);
    if (pids.length === 1) return pids[0]!;
    await sleep(100);
  }
  throw new Error(`App ${APP_ID} did not start on ${udid}.`);
}

function adapterOptions(config: SpikeConfig) {
  return { guestBridge: config.guestBridge, limits: config.limits };
}

function hostLoad(): HostLoad {
  return {
    loadAverage1m: Number(os.loadavg()[0]?.toFixed(2)),
    cpuCores: os.cpus().length,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
