import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createGuestSimulatorFrameworkBridgeAdapter } from './guest-adapter.ts';
import { createAdapterOptions } from './runner.ts';
import type { SpikeConfig } from './config.ts';
import {
  applyPrebootPreferences,
  readSimulatorState,
  restorePrebootPreferences,
  simulatorPreferencePaths,
} from './preferences.ts';
import {
  bootSimulator,
  readRunningAppPids,
  shutdownSimulator,
} from '../ios-snapshot-benchmark/lifecycle.ts';
import type { PreferenceEvidence, SpikeRequest, SpikeResponse } from './types.ts';
import type { TargetedBootstrapSample, TargetedRecoveryProbe } from './corrected-types.ts';

const APP_ID = 'com.callstack.agentdevicelab';

export type TargetedRunResult = Readonly<{
  bootstrap: readonly TargetedBootstrapSample[];
  recovery: readonly TargetedRecoveryProbe[];
  preferenceEvidence: PreferenceEvidence;
  simulator: Readonly<{ finalState: string; accessibilityPlistSha256: string }>;
}>;

export async function runTargetedEvidence(config: SpikeConfig): Promise<TargetedRunResult> {
  shutdownSimulator(config.udid);
  const applied = applyPrebootPreferences(config.udid);
  let restored = false;
  let adapter: ReturnType<typeof createGuestSimulatorFrameworkBridgeAdapter> | undefined;
  let bootstrap: readonly TargetedBootstrapSample[] = [];
  let recovery: readonly TargetedRecoveryProbe[] = [];
  try {
    bootSimulator(config.udid);
    adapter = createGuestSimulatorFrameworkBridgeAdapter(createAdapterOptions(config));
    await launchApp(config.udid);
    bootstrap = await runNonresidentBootstrap(config);
    recovery = await runLiveRecovery(config, adapter);
  } finally {
    await adapter?.close?.();
    shutdownSimulator(config.udid);
    restored = restorePrebootPreferences(config.udid, applied.snapshots);
  }
  const preferenceEvidence = { ...applied.evidence, restored };
  return {
    bootstrap,
    recovery,
    preferenceEvidence,
    simulator: {
      finalState: readSimulatorState(config.udid),
      accessibilityPlistSha256: hashFile(simulatorPreferencePaths(config.udid)[0]!),
    },
  };
}

async function runNonresidentBootstrap(
  config: SpikeConfig,
): Promise<readonly TargetedBootstrapSample[]> {
  const samples: TargetedBootstrapSample[] = [];
  for (let index = 0; index < 5; index += 1) {
    await prepareIndependentBootstrap(config, index);
    samples.push(await captureBootstrap(config, index + 1));
  }
  return samples;
}

async function prepareIndependentBootstrap(config: SpikeConfig, index: number): Promise<void> {
  if (index === 0) return;
  shutdownSimulator(config.udid);
  bootSimulator(config.udid);
  await launchApp(config.udid);
}

async function captureBootstrap(
  config: SpikeConfig,
  index: number,
): Promise<TargetedBootstrapSample> {
  const appPid = readRunningAppPids(config.udid, APP_ID)[0];
  if (appPid === undefined) throw new Error(`App ${APP_ID} has no ready process.`);
  const adapter = createGuestSimulatorFrameworkBridgeAdapter(createAdapterOptions(config));
  const started = performance.now();
  const result = await adapter.acquireBatch([
    request(config, `bootstrap-${index}`, { expectedTargetGeneration: `pid:${appPid}` }),
  ]);
  const response = result.responses[0] ?? failedResponse(config, `bootstrap-${index}`);
  const sample = {
    index,
    durationMs: performance.now() - started,
    usableTree: usableTree(response),
    response,
    stderr: result.stderr,
  };
  await adapter.close?.();
  return sample;
}

async function runLiveRecovery(
  config: SpikeConfig,
  adapter: ReturnType<typeof createGuestSimulatorFrameworkBridgeAdapter>,
): Promise<readonly TargetedRecoveryProbe[]> {
  const probes: TargetedRecoveryProbe[] = [];
  await adapter.acquireBatch([request(config, 'recovery-prime')]);
  const crash = adapter.evidence?.terminateReaderOnNextBatch;
  if (crash) crash();
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
  const pids = readRunningAppPids(config.udid, APP_ID);
  const expectedPid = (pids[0] ?? 1) + 1;
  probes.push(
    await recoveryProbe(
      config,
      adapter,
      'stale-generation',
      request(config, 'recovery-stale-generation', {
        expectedTargetGeneration: `pid:${expectedPid}`,
      }),
    ),
  );
  return probes;
}

async function recoveryProbe(
  config: SpikeConfig,
  adapter: ReturnType<typeof createGuestSimulatorFrameworkBridgeAdapter>,
  operation: TargetedRecoveryProbe['operation'],
  probeRequest: SpikeRequest,
): Promise<TargetedRecoveryProbe> {
  const result = await adapter.acquireBatch([probeRequest]);
  return {
    operation,
    request: probeRequest,
    response: result.responses[0] ?? failedResponse(config, probeRequest.id),
    recoveredResponse: await healthyResponse(config, adapter, `${probeRequest.id}-recovered`),
  };
}

async function cancellationProbe(
  config: SpikeConfig,
  adapter: ReturnType<typeof createGuestSimulatorFrameworkBridgeAdapter>,
): Promise<TargetedRecoveryProbe> {
  const probeRequest = request(config, 'recovery-cancelled');
  const controller = new AbortController();
  const pending = adapter.acquireBatch([probeRequest], { signal: controller.signal });
  setTimeout(() => controller.abort(), 1);
  const result = await pending;
  return {
    operation: 'cancelled',
    request: probeRequest,
    response: result.responses[0] ?? failedResponse(config, probeRequest.id),
    recoveredResponse: await healthyResponse(config, adapter, 'recovery-cancelled-recovered'),
  };
}

async function healthyResponse(
  config: SpikeConfig,
  adapter: ReturnType<typeof createGuestSimulatorFrameworkBridgeAdapter>,
  id: string,
): Promise<SpikeResponse> {
  const result = await adapter.acquireBatch([request(config, id)]);
  return result.responses[0] ?? failedResponse(config, id);
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

function failedResponse(config: SpikeConfig, id: string): SpikeResponse {
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

async function launchApp(udid: string): Promise<void> {
  execFileSync('xcrun', ['simctl', 'launch', udid, APP_ID], {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (readRunningAppPids(udid, APP_ID).length === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`App ${APP_ID} did not become ready on ${udid}.`);
}

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
