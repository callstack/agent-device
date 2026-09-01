import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  classifyFailure,
  openFixture,
  type CliContext,
} from '../ios-snapshot-benchmark/command.ts';
import {
  admitReadyCell,
  admitSuccessfulSample,
  prepareCellState,
  prepareSampleState,
  type CellAdmissionOptions,
} from '../ios-snapshot-benchmark/cell-admission.ts';
import { screenFixture, sampleMinimumForState } from '../ios-snapshot-benchmark/definitions.ts';
import { BenchmarkInfrastructureError, stopDaemon } from '../ios-snapshot-benchmark/lifecycle.ts';
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
  const admission: CellAdmissionOptions = {
    repoRoot: config.repoRoot,
    stateDir: config.stateDir,
    derivedPath: context.derivedPath,
    udid: config.udid,
    samples: config.samples,
    state,
    fixture,
  };
  const acquisitionSamples: SpikeSample[] = [];
  const presentationSamples: SpikeSample[] = [];
  try {
    prepareCellState(admission);
    if (state === 'warm') {
      await collectWarmSamples(
        config,
        adapter,
        context,
        admission,
        acquisitionSamples,
        presentationSamples,
      );
    } else {
      await collectNonWarmSamples(
        config,
        adapter,
        context,
        admission,
        acquisitionSamples,
        presentationSamples,
      );
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

async function collectWarmSamples(
  config: SpikeConfig,
  adapter: AcquisitionAdapter,
  context: CliContext,
  admission: CellAdmissionOptions,
  acquisitionSamples: SpikeSample[],
  presentationSamples: SpikeSample[],
): Promise<void> {
  admitReadyCell(context, admission);
  for (let index = 0; index < config.samples; index += 1) {
    if (index > 0) prepareSampleState(admission);
    const request = makeRequest(
      config,
      adapter.candidate,
      admission.state,
      admission.fixture.id,
      index,
    );
    const captured = await capture(adapter, request);
    appendSamples(
      adapter.candidate,
      admission.state,
      admission.fixture.id,
      index,
      captured,
      0,
      acquisitionSamples,
      presentationSamples,
    );
  }
}

async function collectNonWarmSamples(
  config: SpikeConfig,
  adapter: AcquisitionAdapter,
  context: CliContext,
  admission: CellAdmissionOptions,
  acquisitionSamples: SpikeSample[],
  presentationSamples: SpikeSample[],
): Promise<void> {
  let appPid: number | undefined;
  for (let index = 0; index < config.samples; index += 1) {
    if (index > 0) prepareSampleState(admission);
    const launchStarted = performance.now();
    const opened = openFixture(context, admission.fixture, { relaunch: true });
    if (!opened.ok) {
      throw preparationError(
        opened,
        `open ${admission.fixture.id}`,
        context,
        openArguments(admission.fixture),
      );
    }
    const preparationMs = performance.now() - launchStarted;
    appPid = admitSuccessfulSample(context, admission, opened, appPid);
    const request = makeRequest(
      config,
      adapter.candidate,
      admission.state,
      admission.fixture.id,
      index,
    );
    const captured = await capture(adapter, request);
    appendSamples(
      adapter.candidate,
      admission.state,
      admission.fixture.id,
      index,
      captured,
      preparationMs,
      acquisitionSamples,
      presentationSamples,
    );
  }
}

function openArguments(fixture: ReturnType<typeof screenFixture>): string[] {
  return ['open', fixture.app, '--relaunch', ...launchUrlArguments(fixture), '--foreground'];
}

function launchUrlArguments(fixture: ReturnType<typeof screenFixture>): string[] {
  return fixture.launchUrl ? ['--launch-url', fixture.launchUrl] : [];
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
