import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createPrivateCoreSimulatorAxAdapter,
  createPublicMacOsAxAdapter,
  createXCTestControlAdapter,
} from './adapter.ts';
import { parseConfig, type SpikeConfig } from './config.ts';
import { decideSpike } from './decision.ts';
import { runLifecycleProbes } from './lifecycle.ts';
import {
  applyPrebootPreferences,
  readSimulatorState,
  restorePrebootPreferences,
} from './preferences.ts';
import { markdownPath, writeSpikeReport } from './report.ts';
import { createAdapterOptions, runSpikeCells } from './runner.ts';
import { readGitRevision, readTarget, readToolchain } from '../ios-snapshot-benchmark/host.ts';
import { runDeepButtonControls } from '../ios-snapshot-benchmark/deep-control.ts';
import { deepButtonFixtureEvidence } from '../ios-snapshot-benchmark/deep-button.ts';
import { bootSimulator, shutdownSimulator } from '../ios-snapshot-benchmark/lifecycle.ts';
import { screenFixture } from '../ios-snapshot-benchmark/definitions.ts';
import type { AcquisitionAdapter } from './adapter.ts';
import { SPIKE_ISSUE, SPIKE_PARENT, SPIKE_PREREQUISITES, SPIKE_SCHEMA_VERSION } from './types.ts';
import type {
  PreferenceEvidence,
  ProtocolProbeLog,
  SpikeReport,
  SpikeRequest,
  SpikeResponse,
  Toolchain,
} from './types.ts';

if (isMainModule()) void main(process.argv.slice(2)).catch(reportFailure);

function reportFailure(error: unknown): void {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
}

async function main(argv: readonly string[]): Promise<void> {
  const config = parseConfig(argv);
  const metadata = readMetadata(config);
  const runConfig = { ...config, targetWindowName: metadata.target.name };
  const lifecycle = await runLifecycleProbes();
  const evidence = await executeSpikeRun(runConfig);
  const decision = decideSpike(
    evidence.cells,
    lifecycle,
    evidence.preferenceEvidence,
    config.limits,
    evidence.status,
    evidence.protocolProbes,
  );
  const report = createReport(runConfig, metadata, lifecycle, evidence, decision);
  writeSpikeReport(config.outputPath, report);
  process.stdout.write(
    `Decision: ${report.decision}\nRaw: ${config.outputPath}\nMarkdown: ${markdownPath(config.outputPath)}\n`,
  );
  if (evidence.status === 'stopped') process.exitCode = 2;
}

type SpikeRunEvidence = Readonly<{
  status: SpikeReport['status'];
  stop?: SpikeReport['stop'];
  cells: Awaited<ReturnType<typeof runSpikeCells>>;
  protocolProbes: SpikeResponse[];
  protocolProbeLogs: SpikeReport['protocolProbeLogs'];
  preferenceEvidence: PreferenceEvidence;
  positiveControl: SpikeReport['positiveControl'];
}>;

async function executeSpikeRun(config: SpikeConfig): Promise<SpikeRunEvidence> {
  return collectSpikeEvidence(config);
}

type CollectedSpikeEvidence = SpikeRunEvidence;

async function collectSpikeEvidence(config: SpikeConfig): Promise<CollectedSpikeEvidence> {
  let preferenceEvidence = initialPreferenceEvidence(config.udid);
  let cells: Awaited<ReturnType<typeof runSpikeCells>> = [];
  let protocolProbes: SpikeResponse[] = [];
  let protocolProbeLogs: SpikeReport['protocolProbeLogs'] = [];
  let positiveControl = deepButtonFixtureEvidence();
  let status: SpikeReport['status'] = 'completed';
  let stop: SpikeReport['stop'];
  try {
    positiveControl = runDeepButtonControls(config.repoRoot);
    preferenceEvidence = runPreferenceExperiment(config);
    const adapters = createAdapters(config);
    bootSimulator(config.udid);
    primeFixtureApps(config);
    const probes = await runProtocolProbes(config, adapters);
    protocolProbes = probes.responses;
    protocolProbeLogs = probes.logs;
    cells = await runSpikeCells(config, supportedAdapters(adapters, protocolProbes));
  } catch (error) {
    status = 'stopped';
    stop = stopForError(error);
  }
  if (!config.keepDevice) shutdownSimulator(config.udid);
  return {
    status,
    ...(stop ? { stop } : {}),
    cells,
    protocolProbes,
    protocolProbeLogs,
    preferenceEvidence,
    positiveControl,
  };
}

function primeFixtureApps(config: SpikeConfig): void {
  const apps = new Set(config.screens.map((screen) => screenFixture(screen).app));
  for (const app of apps) {
    if (!tryPrimeFixtureApp(config.udid, app))
      throw new Error(`Failed to prime ${app} after booting the restored disposable Simulator.`);
  }
}

function runPreferenceExperiment(config: SpikeConfig): PreferenceEvidence {
  if (!config.applyPreferences) {
    return initialPreferenceEvidence(config.udid);
  }
  shutdownSimulator(config.udid);
  const applied = applyPrebootPreferences(config.udid);
  let fixtureLaunchCompatible = false;
  let restored = false;
  try {
    bootSimulator(config.udid);
    fixtureLaunchCompatible = tryPrimeFixtureApp(
      config.udid,
      screenFixture(config.screens[0]!).app,
    );
    shutdownSimulator(config.udid);
  } finally {
    try {
      if (readSimulatorState(config.udid) !== 'Shutdown') shutdownSimulator(config.udid);
    } finally {
      restored = restorePrebootPreferences(config.udid, applied.snapshots);
    }
  }
  return {
    ...applied.evidence,
    fixtureLaunchCompatible,
    restored,
  };
}

function tryPrimeFixtureApp(udid: string, app: string): boolean {
  try {
    execFileSync('xcrun', ['simctl', 'launch', udid, app], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function stopForError(error: unknown): SpikeReport['stop'] {
  return {
    category: isConfigurationError(error) ? 'configuration' : 'infrastructure',
    message: error instanceof Error ? error.message : String(error),
    ...(errorCommand(error) ? { command: errorCommand(error) } : {}),
  };
}

function createReport(
  config: SpikeConfig,
  metadata: { target: SpikeReport['target']; toolchain: Toolchain },
  lifecycle: SpikeReport['lifecycle'],
  evidence: SpikeRunEvidence,
  decision: { decision: SpikeReport['decision']; reasons: string[] },
): SpikeReport {
  return {
    schemaVersion: SPIKE_SCHEMA_VERSION,
    issue: SPIKE_ISSUE,
    parent: SPIKE_PARENT,
    prerequisites: SPIKE_PREREQUISITES,
    generatedAt: new Date().toISOString(),
    revision: readGitRevision(config.repoRoot),
    toolchain: metadata.toolchain,
    target: metadata.target,
    limits: config.limits,
    candidates: config.candidates,
    config: {
      states: config.states,
      screens: config.screens,
      requestedSamples: config.samples,
    },
    protocolProbes: evidence.protocolProbes,
    protocolProbeLogs: evidence.protocolProbeLogs,
    preferenceEvidence: evidence.preferenceEvidence,
    lifecycle,
    positiveControl: evidence.positiveControl,
    status: evidence.status,
    corpusCoverage: corpusCoverage(config),
    cells: evidence.cells,
    decision: decision.decision,
    decisionReasons: decision.reasons,
    nextInterface:
      'Keep any future bridge behind the #2190 acquisition adapter and preserve raw facts until a separate GO evidence run proves fidelity, lifecycle, and latency.',
    ...(evidence.stop ? { stop: evidence.stop } : {}),
  };
}

function createAdapters(config: SpikeConfig) {
  const options = createAdapterOptions(config);
  const adapters = config.candidates.flatMap((candidate) => {
    if (candidate === 'public-macos-ax') return [createPublicMacOsAxAdapter(options)];
    if (candidate === 'private-coresimulator-ax')
      return [createPrivateCoreSimulatorAxAdapter(options)];
    return [
      createXCTestControlAdapter((request) => ({
        repoRoot: config.repoRoot,
        stateDir: config.stateDir,
        session: `ax-spike-xctest-control-${request.state ?? 'state'}-${request.screen}`,
        udid: request.simulatorUdid,
        derivedPath: path.join(config.derivedPath, 'xctest-control', request.screen),
      })),
    ];
  });
  return adapters;
}

async function runProtocolProbes(
  config: SpikeConfig,
  adapters: readonly AcquisitionAdapter[],
): Promise<{ responses: SpikeResponse[]; logs: SpikeReport['protocolProbeLogs'] }> {
  const responses: SpikeResponse[] = [];
  const logs: ProtocolProbeLog[] = [];
  for (const adapter of adapters.filter(isBridgeAdapter)) {
    const request = protocolProbeRequest(config, adapter.candidate);
    const result = await adapter.acquireBatch([request]);
    responses.push(...result.responses.slice(0, 1));
    logs.push({ candidate: adapter.candidate, id: request.id, stderr: result.stderr });
  }
  return { responses, logs };
}

function isBridgeAdapter(adapter: AcquisitionAdapter): adapter is AcquisitionAdapter & {
  candidate: Exclude<SpikeRequest['candidate'], 'xctest-control'>;
} {
  return adapter.candidate !== 'xctest-control';
}

function protocolProbeRequest(
  config: SpikeConfig,
  candidate: Exclude<SpikeRequest['candidate'], 'xctest-control'>,
): SpikeRequest {
  return {
    version: 1,
    id: `protocol-probe:${candidate}`,
    candidate,
    simulatorUdid: config.udid,
    state: 'warm',
    screen: 'unprepared-surface',
    appBundleId: config.appBundleId,
    ...(config.targetWindowName === undefined ? {} : { targetWindowName: config.targetWindowName }),
    ...(config.targetProcessId === undefined ? {} : { targetProcessId: config.targetProcessId }),
    limits: config.limits,
  };
}

function readMetadata(config: SpikeConfig): {
  target: SpikeReport['target'];
  toolchain: Toolchain;
} {
  const target = readTarget(config.udid, 'com.callstack.agentdevicelab');
  const base = readToolchain();
  return {
    target: { udid: target.udid, name: target.name, runtime: target.runtime },
    toolchain: { ...base, swift: commandText('swift', ['--version']) },
  };
}

function initialPreferenceEvidence(udid: string): PreferenceEvidence {
  let simulatorStateBefore = 'unknown';
  try {
    simulatorStateBefore = readSimulatorState(udid);
  } catch {
    simulatorStateBefore = 'unavailable';
  }
  return {
    applied: false,
    restored: false,
    fixtureLaunchCompatible: null,
    simulatorStateBefore,
    diffs: [],
  };
}

function supportedAdapters(
  adapters: readonly AcquisitionAdapter[],
  probes: readonly SpikeResponse[],
): readonly AcquisitionAdapter[] {
  return adapters.filter((adapter) => {
    if (adapter.candidate === 'xctest-control') return true;
    const probe = probes.find((candidate) => candidate.candidate === adapter.candidate);
    return probe?.failure?.kind !== 'unsupported-mechanism';
  });
}

function corpusCoverage(config: SpikeConfig): SpikeReport['corpusCoverage'] {
  const fullStates = ['cold-cold', 'cold', 'warm', 'relaunch'];
  const fullScreens = [
    'quiet',
    'list',
    'nested-scroll',
    'alert',
    'system-surface',
    'xctest-stress',
  ];
  return fullStates.every((state) =>
    config.states.includes(state as SpikeConfig['states'][number]),
  ) &&
    fullScreens.every((screen) => config.screens.includes(screen as SpikeConfig['screens'][number]))
    ? 'full'
    : 'decisive-early-stop';
}

function commandText(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, [...args], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unavailable';
  }
}

function isConfigurationError(error: unknown): boolean {
  return error instanceof Error && error.name === 'SpikeConfigurationError';
}

function errorCommand(error: unknown): string | undefined {
  if (error instanceof Error && 'command' in error) {
    const command = error.command;
    return typeof command === 'string' ? command : undefined;
  }
  return undefined;
}

function isMainModule(): boolean {
  return Boolean(
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)),
  );
}
