import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  classifyFailure,
  openFixture,
  pressFixtureTarget,
  snapshotFixture,
  type CliContext,
} from '../ios-snapshot-benchmark/command.ts';
import { screenFixture, sampleMinimumForState } from '../ios-snapshot-benchmark/definitions.ts';
import {
  BenchmarkInfrastructureError,
  bootSimulator,
  clearDerivedData,
  shutdownSimulator,
  stopDaemon,
  terminateApp,
} from '../ios-snapshot-benchmark/lifecycle.ts';
import { appendSamples, makeRequest, type CapturedResponse } from './sample-evidence.ts';
import type { AcquisitionAdapter, AdapterOptions } from './adapter.ts';
import type { SpikeConfig } from './config.ts';
import type { CandidateId, SpikeCell, SpikeRequest, SpikeSample } from './types.ts';

export async function runSpikeCells(
  config: SpikeConfig,
  adapters: readonly AcquisitionAdapter[],
): Promise<readonly SpikeCell[]> {
  const cells: SpikeCell[] = [];
  for (const adapter of adapters) {
    for (const state of config.states) {
      for (const screen of config.screens) {
        cells.push(await runCell(config, adapter, state, screen));
      }
    }
  }
  return cells;
}

export function createAdapterOptions(config: SpikeConfig): AdapterOptions {
  return {
    repoRoot: config.repoRoot,
    ...(config.privateTool ? { privateTool: config.privateTool } : {}),
    ...(config.helperPath ? { helperPath: config.helperPath } : {}),
    limits: config.limits,
  };
}

async function runCell(
  config: SpikeConfig,
  adapter: AcquisitionAdapter,
  state: SpikeConfig['states'][number],
  screen: SpikeConfig['screens'][number],
): Promise<SpikeCell> {
  const fixture = screenFixture(screen);
  const context = contextFor(config, adapter.candidate, state, screen);
  const acquisitionSamples: SpikeSample[] = [];
  const presentationSamples: SpikeSample[] = [];
  try {
    if (state === 'warm') {
      const preparationMs = prepareSample(config, context, fixture, state);
      const requests = Array.from({ length: config.samples }, (_, index) =>
        makeRequest(config, adapter.candidate, state, screen, index),
      );
      const captured = await captureBatch(adapter, requests);
      captured.forEach((item, index) =>
        appendSamples(
          adapter.candidate,
          state,
          screen,
          index,
          item,
          preparationMs,
          acquisitionSamples,
          presentationSamples,
        ),
      );
    } else {
      for (let index = 0; index < config.samples; index += 1) {
        const preparationMs = prepareSample(config, context, fixture, state);
        const request = makeRequest(config, adapter.candidate, state, screen, index);
        const captured = await capture(adapter, request);
        appendSamples(
          adapter.candidate,
          state,
          screen,
          index,
          captured,
          preparationMs,
          acquisitionSamples,
          presentationSamples,
        );
        closeSession(context);
      }
    }
    return {
      candidate: adapter.candidate,
      state,
      screen,
      sampleMinimum: sampleMinimumForState(state),
      acquisitionSamples,
      presentationSamples,
    };
  } finally {
    closeSession(context);
    stopDaemon(config.repoRoot, config.stateDir);
  }
}

function prepareSample(
  config: SpikeConfig,
  context: CliContext,
  fixture: ReturnType<typeof screenFixture>,
  state: SpikeConfig['states'][number],
): number {
  prepareSimulator(config, context, fixture, state);
  const started = performance.now();
  openReadyFixture(context, fixture, state);
  return performance.now() - started;
}

function prepareSimulator(
  config: SpikeConfig,
  context: CliContext,
  fixture: ReturnType<typeof screenFixture>,
  state: SpikeConfig['states'][number],
): void {
  if (state === 'cold-cold') return prepareColdCold(config, context);
  bootSimulator(config.udid);
  if (state === 'cold') prepareCold(config, fixture);
}

function prepareColdCold(config: SpikeConfig, context: CliContext): void {
  shutdownSimulator(config.udid);
  stopDaemon(config.repoRoot, config.stateDir);
  clearDerivedData(context.derivedPath);
  bootSimulator(config.udid);
}

function prepareCold(config: SpikeConfig, fixture: ReturnType<typeof screenFixture>): void {
  stopDaemon(config.repoRoot, config.stateDir);
  terminateApp(config.udid, fixture.app);
}

function openReadyFixture(
  context: CliContext,
  fixture: ReturnType<typeof screenFixture>,
  state: SpikeConfig['states'][number],
): void {
  const opened = openFixture(context, fixture, { relaunch: requiresRelaunch(state) });
  if (!opened.ok) {
    throw preparationError(opened, `open ${fixture.id}`, context, openArguments(fixture, state));
  }
  if (fixture.setupAction === 'open-alert') prepareAlert(context, fixture);
}

function requiresRelaunch(state: SpikeConfig['states'][number]): boolean {
  return state === 'relaunch' || state === 'warm';
}

function openArguments(
  fixture: ReturnType<typeof screenFixture>,
  state: SpikeConfig['states'][number],
): string[] {
  return [
    'open',
    fixture.app,
    ...relaunchArguments(state),
    ...launchUrlArguments(fixture),
    '--foreground',
  ];
}

function relaunchArguments(state: SpikeConfig['states'][number]): string[] {
  return requiresRelaunch(state) ? ['--relaunch'] : [];
}

function launchUrlArguments(fixture: ReturnType<typeof screenFixture>): string[] {
  return fixture.launchUrl ? ['--launch-url', fixture.launchUrl] : [];
}

function prepareAlert(context: CliContext, fixture: ReturnType<typeof screenFixture>): void {
  const pressed = pressFixtureTarget(context, 'id="automation-open-alert"');
  if (!pressed.ok) {
    throw preparationError(pressed, `prepare alert ${fixture.id}`, context, [
      'click',
      'id="automation-open-alert"',
    ]);
  }
  const observed = snapshotFixture(context);
  if (!observed.ok) {
    throw preparationError(observed, `observe alert ${fixture.id}`, context, [
      'batch',
      '--steps',
      JSON.stringify([{ command: 'snapshot', input: { interactiveOnly: true } }]),
    ]);
  }
}

async function capture(
  adapter: AcquisitionAdapter,
  request: SpikeRequest,
): Promise<CapturedResponse> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const batch = await adapter.acquireBatch([request]);
  const response = batch.responses[0];
  if (!response) {
    throw new BenchmarkInfrastructureError(`Adapter ${adapter.candidate} returned no response.`);
  }
  return {
    response,
    stderr: batch.stderr,
    startedAt,
    wallClockMs: performance.now() - started,
  };
}

async function captureBatch(
  adapter: AcquisitionAdapter,
  requests: readonly SpikeRequest[],
): Promise<CapturedResponse[]> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const batch = await adapter.acquireBatch(requests);
  const batchWallClockMs = performance.now() - started;
  if (batch.responses.length !== requests.length) {
    throw new BenchmarkInfrastructureError(
      `Adapter ${adapter.candidate} returned an incomplete batch.`,
    );
  }
  return batch.responses.map((response) => ({
    response,
    stderr: batch.stderr,
    startedAt,
    wallClockMs: response.metrics.durationMs > 0 ? response.metrics.durationMs : batchWallClockMs,
  }));
}

function contextFor(
  config: SpikeConfig,
  candidate: CandidateId,
  state: SpikeConfig['states'][number],
  screen: SpikeConfig['screens'][number],
): CliContext {
  return {
    repoRoot: config.repoRoot,
    stateDir: config.stateDir,
    session: `ax-spike-${candidate}-${state}-${screen}`,
    udid: config.udid,
    derivedPath: path.join(config.derivedPath, candidate, state, screen),
  };
}

function closeSession(context: CliContext): void {
  spawnSync(
    process.execPath,
    [
      'bin/agent-device.mjs',
      'close',
      '--state-dir',
      context.stateDir,
      '--session',
      context.session,
      '--platform',
      'ios',
      '--udid',
      context.udid,
      '--json',
    ],
    {
      cwd: context.repoRoot,
      env: { ...process.env, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' },
      stdio: 'ignore',
      timeout: 60_000,
    },
  );
}

function preparationError(
  result: { payload: unknown; stderr: string; exitCode: number },
  operation: string,
  context: CliContext,
  args: readonly string[],
): Error {
  const failure = classifyFailure(result.payload, result);
  return new BenchmarkInfrastructureError(
    `${operation} failed during fixture preparation (exit ${result.exitCode}; ${failureDetails(failure, result)})`,
    commandFor(context, args),
  );
}

function failureDetails(
  failure: ReturnType<typeof classifyFailure>,
  result: { stderr: string },
): string {
  return `code=${fallbackText(failure.code)}; reason=${fallbackText(failure.reason)}; diagnostic=${diagnosticText(failure.message, result.stderr)}`;
}

function fallbackText(value: string | undefined): string {
  return value ?? 'none';
}

function diagnosticText(message: string | undefined, stderr: string): string {
  const text = message ?? stderr.trim();
  return (text || 'no diagnostic').slice(0, 800);
}

function commandFor(context: CliContext, args: readonly string[]): string {
  return [
    process.execPath,
    'bin/agent-device.mjs',
    ...args,
    '--state-dir',
    context.stateDir,
    '--session',
    context.session,
    '--platform',
    'ios',
    '--udid',
    context.udid,
    '--ios-xctest-derived-data-path',
    context.derivedPath,
    '--json',
  ].join(' ');
}
