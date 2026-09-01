import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  openFixture,
  sampleFromCli,
  snapshotFixture,
  type CliContext,
  type CliResult,
} from './command.ts';
import {
  admitReadyCell,
  admitSuccessfulSample,
  cleanupSuccessfulSample,
  prepareCellState,
  prepareSampleState,
  type CellAdmissionOptions,
} from './cell-admission.ts';
import { sampleMinimumForState } from './definitions.ts';
import { stopDaemon } from './lifecycle.ts';
import { buildMeasurement } from './statistics.ts';
import type { LocalState, Measurement, RawSample, ScreenFixture } from './types.ts';

type LocalRunnerOptions = {
  repoRoot: string;
  stateDir: string;
  derivedPath: string;
  udid: string;
  fixtures: ScreenFixture[];
  states: LocalState[];
  samples: number;
};

export async function runLocalMeasurements(options: LocalRunnerOptions): Promise<Measurement[]> {
  const measurements: Measurement[] = [];
  for (const state of options.states) {
    for (const fixture of options.fixtures) {
      measurements.push(await runCell({ ...options, state, fixture }));
    }
  }
  return measurements;
}

async function runCell(options: CellAdmissionOptions): Promise<Measurement> {
  const context = contextFor(options);
  let appPid: number | undefined;
  try {
    prepareCellState(options);
    appPid = await admitReadyCell(context, options);
    const samples: RawSample[] = [];
    for (let index = 0; index < options.samples; index += 1) {
      if (index > 0) prepareSampleState(options);
      const result = runMeasuredCommand(context, options);
      if (result.ok) {
        appPid = await admitSuccessfulSample(context, options, result, appPid);
        cleanupSuccessfulSample(context, options);
      }
      samples.push(sampleFromCli(result, measuredOperation(options.state), index));
    }
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

function runMeasuredCommand(context: CliContext, options: CellAdmissionOptions): CliResult {
  if (options.state === 'warm') return snapshotFixture(context);
  return openFixture(context, options.fixture, { relaunch: true });
}

function measuredOperation(
  state: LocalState,
): 'open-foreground' | 'snapshot' | 'relaunch-foreground' {
  if (state === 'warm') return 'snapshot';
  if (state === 'relaunch') return 'relaunch-foreground';
  return 'open-foreground';
}

function contextFor(options: CellAdmissionOptions): CliContext {
  return {
    repoRoot: options.repoRoot,
    stateDir: options.stateDir,
    session: `bench-${options.state}-${options.fixture.id}`,
    udid: options.udid,
    derivedPath: path.join(options.derivedPath, options.state, options.fixture.id),
  };
}

export function closeSession(context: CliContext): void {
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
