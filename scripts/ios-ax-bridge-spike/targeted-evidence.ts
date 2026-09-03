import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createGuestSimulatorFrameworkBridgeAdapter } from './guest-adapter.ts';
import type { SpikeConfig } from './config.ts';
import { runTargetedRelaunch } from './targeted-relaunch.ts';
import { awaitAppReadiness } from './targeted-readiness.ts';
import {
  adapterOptions,
  missingResponse,
  targetedRequest,
  usableTree,
} from './targeted-request.ts';
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
  TargetedRelaunchSample,
  TargetedRecoveryProbe,
} from './corrected-types.ts';

const APP_ID = 'com.callstack.agentdevicelab';
const BOOTSTRAP_SAMPLES = 5;

type GuestAdapter = ReturnType<typeof createGuestSimulatorFrameworkBridgeAdapter>;

export type TargetedRunResult = Readonly<{
  bootstrap: readonly TargetedBootstrapSample[];
  relaunch: readonly TargetedRelaunchSample[];
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
      relaunch: await runTargetedRelaunch(config),
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
  const readiness = await awaitAppReadiness(config, appPid, 'list');
  await assertNoResidentGuest();
  const adapter = createGuestSimulatorFrameworkBridgeAdapter(adapterOptions(config));
  const started = performance.now();
  const result = await adapter.acquireBatch([
    targetedRequest(config, `bootstrap-${index}`, {
      expectedTargetGeneration: `pid:${appPid}`,
    }),
  ]);
  const durationMs = performance.now() - started;
  await adapter.close?.();
  const response = result.responses[0] ?? missingResponse(`bootstrap-${index}`);
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
    await adapter.acquireBatch([targetedRequest(config, 'recovery-prime')]);
    adapter.evidence?.terminateReaderOnNextBatch?.();
    probes.push(
      await recoveryProbe(
        config,
        adapter,
        'process-crash',
        targetedRequest(config, 'recovery-crash'),
      ),
    );
    probes.push(
      await recoveryProbe(
        config,
        adapter,
        'timeout',
        targetedRequest(config, 'recovery-timeout', {
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
        targetedRequest(config, 'recovery-stale-generation', {
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
    response: result.responses[0] ?? missingResponse(probeRequest.id),
    recoveredResponse: await healthyResponse(config, adapter, `${probeRequest.id}-recovered`),
  };
}

async function cancellationProbe(
  config: SpikeConfig,
  adapter: GuestAdapter,
): Promise<TargetedRecoveryProbe> {
  const probeRequest = targetedRequest(config, 'recovery-cancelled');
  const controller = new AbortController();
  const pending = adapter.acquireBatch([probeRequest], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 1);
  const result = await pending;
  return {
    operation: 'cancelled',
    request: probeRequest,
    response: result.responses[0] ?? missingResponse(probeRequest.id),
    recoveredResponse: await healthyResponse(config, adapter, 'recovery-cancelled-recovered'),
  };
}

async function healthyResponse(
  config: SpikeConfig,
  adapter: GuestAdapter,
  id: string,
): Promise<SpikeResponse> {
  const result = await adapter.acquireBatch([targetedRequest(config, id)]);
  return result.responses[0] ?? missingResponse(id);
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

function hostLoad(): HostLoad {
  return {
    loadAverage1m: Number(os.loadavg()[0]?.toFixed(2)),
    cpuCores: os.cpus().length,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
