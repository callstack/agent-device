import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  openFixture,
  pressFixtureTarget,
  classifyFailure,
  formatCliFailure,
  sampleFromCli,
  snapshotFixture,
  type CliContext,
  type CliResult,
} from './command.ts';
import {
  BenchmarkContentionError,
  clearDerivedData,
  bootSimulator,
  shutdownSimulator,
  stopDaemon,
  terminateApp,
} from './lifecycle.ts';
import { sampleMinimumForState } from './definitions.ts';
import { buildMeasurement } from './statistics.ts';
import type { LocalState, Measurement, RawSample, ScreenFixture } from './types.ts';

export async function runLocalMeasurements(options: {
  repoRoot: string;
  stateDir: string;
  derivedPath: string;
  udid: string;
  fixtures: ScreenFixture[];
  states: LocalState[];
  samples: number;
}): Promise<Measurement[]> {
  const measurements: Measurement[] = [];
  for (const state of options.states) {
    for (const fixture of options.fixtures) {
      measurements.push(await runCell({ ...options, state, fixture }));
    }
  }
  return measurements;
}

async function runCell(options: {
  repoRoot: string;
  stateDir: string;
  derivedPath: string;
  udid: string;
  samples: number;
  state: LocalState;
  fixture: ScreenFixture;
}): Promise<Measurement> {
  const context = contextFor(options);
  prepareState(options);
  try {
    prepareReadyCell(context, options);
    const samples = collectCellSamples(context, options);
    return buildMeasurement({
      transport: 'local',
      execution: 'fresh-process-cli',
      state: options.state,
      screen: options.fixture.id,
      sampleMinimum: sampleMinimumForState(options.state),
      operation: measuredOperation(options.state),
      samples,
    });
  } finally {
    closeSession(context);
    stopDaemon(options.repoRoot, options.stateDir);
  }
}

function prepareReadyCell(
  context: CliContext,
  options: { state: LocalState; fixture: ScreenFixture },
): void {
  if (options.state !== 'warm' && options.state !== 'relaunch') return;
  const opened = openFixture(context, options.fixture, { relaunch: true });
  requireSetupSuccess(opened, `warm ${options.fixture.id} setup`);
  prepareScreen(context, options.fixture);
}

function collectCellSamples(
  context: CliContext,
  options: {
    repoRoot: string;
    stateDir: string;
    derivedPath: string;
    udid: string;
    samples: number;
    state: LocalState;
    fixture: ScreenFixture;
  },
): RawSample[] {
  const samples: RawSample[] = [];
  for (let index = 0; index < options.samples; index += 1) {
    prepareColdSampleForState(options);
    const result = runMeasuredCommand(context, options);
    samples.push(sampleFromCli(result, measuredOperation(options.state), index));
    if (shouldPrepareScreen(result, options)) prepareScreen(context, options.fixture);
  }
  return samples;
}

function prepareColdSampleForState(options: {
  repoRoot: string;
  stateDir: string;
  derivedPath: string;
  udid: string;
  state: LocalState;
  fixture: ScreenFixture;
}): void {
  if (options.state === 'cold-cold') return prepareColdColdSample(options);
  if (options.state === 'cold') prepareColdSample(options);
}

function shouldPrepareScreen(
  result: CliResult,
  options: { fixture: ScreenFixture; state: LocalState },
): boolean {
  return result.ok && options.fixture.setupAction !== undefined && options.state !== 'warm';
}

function prepareState(options: {
  repoRoot: string;
  stateDir: string;
  derivedPath: string;
  udid: string;
  state: LocalState;
}): void {
  if (options.state === 'cold-cold') {
    shutdownSimulator(options.udid);
    stopDaemon(options.repoRoot, options.stateDir);
    clearDerivedData(options.derivedPath);
    bootSimulator(options.udid);
    return;
  }
  bootSimulator(options.udid);
  if (options.state === 'cold') stopDaemon(options.repoRoot, options.stateDir);
}

function prepareColdColdSample(options: {
  repoRoot: string;
  stateDir: string;
  derivedPath: string;
  udid: string;
}): void {
  shutdownSimulator(options.udid);
  stopDaemon(options.repoRoot, options.stateDir);
  clearDerivedData(options.derivedPath);
  bootSimulator(options.udid);
}

function prepareColdSample(options: {
  repoRoot: string;
  stateDir: string;
  udid: string;
  fixture: ScreenFixture;
}): void {
  stopDaemon(options.repoRoot, options.stateDir);
  terminateApp(options.udid, options.fixture.app);
}

function runMeasuredCommand(
  context: CliContext,
  options: { fixture: ScreenFixture; state: LocalState },
) {
  if (options.state === 'warm') return snapshotFixture(context);
  return openFixture(context, options.fixture, { relaunch: true });
}

function prepareScreen(context: CliContext, fixture: ScreenFixture): void {
  if (!fixture.setupAction) return;
  const result = pressFixtureTarget(context, 'id="automation-open-alert"');
  requireSetupSuccess(result, `${fixture.id} setup action`);
  const observed = snapshotFixture(context);
  requireSetupSuccess(observed, `${fixture.id} native surface observation`);
}

function requireSetupSuccess(result: CliResult, operation: string): void {
  if (result.ok) return;
  const failure = classifyFailure(result.payload, result);
  const message = formatCliFailure(operation, failure, result);
  if (failure.code === 'DEVICE_IN_USE') throw new BenchmarkContentionError(message, operation);
  throw new Error(message);
}

function measuredOperation(
  state: LocalState,
): 'open-foreground' | 'snapshot' | 'relaunch-foreground' {
  if (state === 'warm') return 'snapshot';
  if (state === 'relaunch') return 'relaunch-foreground';
  return 'open-foreground';
}

function contextFor(options: {
  repoRoot: string;
  stateDir: string;
  derivedPath: string;
  udid: string;
  state: LocalState;
  fixture: ScreenFixture;
}): CliContext {
  return {
    repoRoot: options.repoRoot,
    stateDir: options.stateDir,
    session: `bench-${options.state}-${options.fixture.id}`,
    udid: options.udid,
    derivedPath: path.join(options.derivedPath, options.state, options.fixture.id),
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
      stdio: 'ignore',
      timeout: 60_000,
    },
  );
}
