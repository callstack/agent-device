import fs from 'node:fs';
import { resolveDaemonPaths } from '../../src/daemon/config.ts';
import { readDaemonInfo } from '../../src/daemon/client/daemon-client-metadata.ts';
import { isAgentDeviceDaemonProcess } from '../../src/daemon/daemon-process.ts';
import {
  openFixture,
  pressFixtureTarget,
  scrollFixtureSetup,
  snapshotFixture,
  type CliContext,
  type CliResult,
} from './command.ts';
import {
  fixtureOperationFromCli,
  prepareFixture,
  requireFixtureAnchor,
  requireFixtureOperationSuccess,
} from './fixture-admission.ts';
import {
  BenchmarkCellAdmissionError,
  bootSimulator,
  readRunningAppPids,
  readSimulatorState,
  shutdownSimulator,
  stopDaemon,
  terminateApp,
} from './lifecycle.ts';
import { clearDerivedData } from './state-ownership.ts';
import type { LocalState, ScreenFixture } from './types.ts';

export type CellAdmissionOptions = {
  repoRoot: string;
  stateDir: string;
  derivedPath: string;
  udid: string;
  samples: number;
  state: LocalState;
  fixture: ScreenFixture;
};

export function prepareCellState(options: CellAdmissionOptions): void {
  if (options.state === 'cold-cold') {
    prepareColdColdState(options);
    return;
  }
  stopDaemon(options.repoRoot, options.stateDir);
  assertDaemonStopped(options.stateDir);
  bootSimulator(options.udid);
  assertSimulatorState(options.udid, 'Booted');
  if (options.state === 'cold') {
    terminateApp(options.udid, options.fixture.app);
    assertAppStopped(options.udid, options.fixture.app);
  }
}

export function prepareSampleState(options: CellAdmissionOptions): void {
  if (options.state === 'cold-cold') {
    prepareColdColdState(options);
    return;
  }
  if (options.state === 'cold') {
    stopDaemon(options.repoRoot, options.stateDir);
    assertDaemonStopped(options.stateDir);
    terminateApp(options.udid, options.fixture.app);
    assertAppStopped(options.udid, options.fixture.app);
    return;
  }
  assertReadyState(options);
}

export async function admitReadyCell(
  context: CliContext,
  options: CellAdmissionOptions,
): Promise<number | undefined> {
  if (options.state !== 'warm' && options.state !== 'relaunch') return undefined;
  const opened = openFixture(context, options.fixture, { relaunch: true });
  requireFixtureOperationSuccess(
    fixtureOperationFromCli(opened, `${options.state} ${options.fixture.id} setup`),
    `${options.state} ${options.fixture.id} setup`,
    'cell-state',
  );
  return await admitOpenedFixture(context, options);
}

export async function admitSuccessfulSample(
  context: CliContext,
  options: CellAdmissionOptions,
  result: CliResult,
  previousAppPid: number | undefined,
): Promise<number | undefined> {
  if (!result.ok) return previousAppPid;
  if (options.state === 'warm') {
    return admitWarmSample(options, result, previousAppPid);
  }
  return await admitNonWarmSample(context, options, previousAppPid);
}

export function cleanupSuccessfulSample(context: CliContext, options: CellAdmissionOptions): void {
  if (options.state !== 'relaunch' || options.fixture.setupAction !== 'open-alert') return;
  const dismissed = pressFixtureTarget(context, 'label="Cancel"');
  requireFixtureOperationSuccess(
    fixtureOperationFromCli(dismissed, 'agent-device click label="Cancel"'),
    `${options.fixture.id} sample cleanup`,
    'cell-state',
  );
}

async function admitNonWarmSample(
  context: CliContext,
  options: CellAdmissionOptions,
  previousAppPid: number | undefined,
): Promise<number> {
  const appPid = await admitOpenedFixture(context, options);
  if (options.state !== 'relaunch') return appPid;
  if (previousAppPid === appPid) {
    throw new BenchmarkCellAdmissionError(
      'cell-state',
      `Relaunch cell ${options.fixture.id} reused app PID ${String(appPid)}.`,
      'agent-device open --relaunch',
    );
  }
  return appPid;
}

function prepareColdColdState(options: CellAdmissionOptions): void {
  stopDaemon(options.repoRoot, options.stateDir);
  assertDaemonStopped(options.stateDir);
  shutdownSimulator(options.udid);
  assertSimulatorState(options.udid, 'Shutdown');
  clearDerivedData(options.derivedPath, options.stateDir);
  bootSimulator(options.udid);
  assertSimulatorState(options.udid, 'Booted');
  assertAppStopped(options.udid, options.fixture.app);
}

function admitWarmSample(
  options: CellAdmissionOptions,
  result: CliResult,
  previousAppPid: number | undefined,
): number {
  assertReadyState(options);
  requireFixtureAnchor(result.payload, options.fixture, 'sample');
  const appPid = assertAppRunning(options.udid, options.fixture.app);
  if (previousAppPid !== undefined && appPid !== previousAppPid) {
    throw new BenchmarkCellAdmissionError(
      'cell-state',
      `Warm cell ${options.fixture.id} changed app PID from ${String(previousAppPid)} to ${String(appPid)}.`,
      'agent-device batch --steps snapshot',
    );
  }
  return appPid;
}

async function admitOpenedFixture(
  context: CliContext,
  options: CellAdmissionOptions,
): Promise<number> {
  assertSimulatorState(options.udid, 'Booted');
  assertDaemonRunning(options.stateDir);
  assertAppRunning(options.udid, options.fixture.app);
  await prepareFixture(options.fixture, {
    observe: () =>
      fixtureOperationFromCli(snapshotFixture(context), 'agent-device batch --steps snapshot'),
    scrollToBottom: () =>
      fixtureOperationFromCli(scrollFixtureSetup(context), 'agent-device scroll bottom'),
    openAlert: () =>
      fixtureOperationFromCli(
        pressFixtureTarget(context, 'id="automation-open-alert"'),
        'agent-device click id="automation-open-alert"',
      ),
  });
  const appPid = assertAppRunning(options.udid, options.fixture.app);
  return appPid;
}

function assertReadyState(options: CellAdmissionOptions): void {
  assertSimulatorState(options.udid, 'Booted');
  assertDaemonRunning(options.stateDir);
  assertAppRunning(options.udid, options.fixture.app);
}

function assertSimulatorState(udid: string, expected: string): void {
  const actual = readSimulatorState(udid);
  if (actual !== expected) {
    throw new BenchmarkCellAdmissionError(
      'cell-state',
      `Simulator ${udid} was ${actual}, expected ${expected}.`,
      `xcrun simctl list devices available --json`,
    );
  }
}

function assertDaemonStopped(stateDir: string): void {
  const paths = resolveDaemonPaths(stateDir);
  if (fs.existsSync(paths.infoPath) || fs.existsSync(paths.lockPath)) {
    throw new BenchmarkCellAdmissionError(
      'cell-state',
      `Daemon state remained active in ${stateDir}.`,
      'agent-device daemon stop --clean',
    );
  }
}

function assertDaemonRunning(stateDir: string): void {
  const info = readDaemonInfo(resolveDaemonPaths(stateDir).infoPath);
  if (!info?.processStartTime || !isAgentDeviceDaemonProcess(info.pid, info.processStartTime)) {
    throw new BenchmarkCellAdmissionError(
      'cell-state',
      `Daemon admission failed for ${stateDir}; no verified daemon identity is running.`,
      'agent-device daemon status',
    );
  }
}

function assertAppStopped(udid: string, appId: string): void {
  const pids = readRunningAppPids(udid, appId);
  if (pids.length > 0) {
    throw new BenchmarkCellAdmissionError(
      'cell-state',
      `App ${appId} remained running on simulator ${udid}: ${pids.join(', ')}.`,
      `xcrun simctl spawn ${udid} launchctl list`,
    );
  }
}

function assertAppRunning(udid: string, appId: string): number {
  const pids = readRunningAppPids(udid, appId);
  if (pids.length !== 1) {
    throw new BenchmarkCellAdmissionError(
      'cell-state',
      `Expected one running ${appId} process on ${udid}; observed ${pids.length}.`,
      `xcrun simctl spawn ${udid} launchctl list`,
    );
  }
  return pids[0]!;
}
