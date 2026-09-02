import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createXCTestControlAdapter } from './adapter.ts';
import {
  createGuestSimulatorFrameworkBridgeAdapter,
  GUEST_MECHANISM_EVIDENCE,
} from './guest-adapter.ts';
import { parseConfig, type SpikeConfig } from './config.ts';
import { decideSpike } from './decision.ts';
import { runLifecycleProbes } from './lifecycle.ts';
import { markdownPath, writeSpikeReport } from './report.ts';
import { corpusCoverage } from './corpus-coverage.ts';
import {
  initialPreferenceEvidence,
  primeFixtureApps,
  runPreferenceExperiment,
} from './preference-experiment.ts';
import { createAdapterOptions, runSpikeCells } from './runner.ts';
import { readGitRevision, readTarget, readToolchain } from '../ios-snapshot-benchmark/host.ts';
import { runDeepButtonControls } from '../ios-snapshot-benchmark/deep-control.ts';
import { deepButtonFixtureEvidence } from '../ios-snapshot-benchmark/deep-button.ts';
import { bootSimulator, shutdownSimulator } from '../ios-snapshot-benchmark/lifecycle.ts';
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
  const lifecycle = await runLifecycleProbes();
  const evidence = await collectSpikeEvidence(config);
  const decision = decideSpike(
    evidence.cells,
    lifecycle,
    evidence.preferenceEvidence,
    config.limits,
    evidence.status,
    evidence.protocolProbes,
  );
  const report = createReport(config, metadata, lifecycle, evidence, decision);
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

async function collectSpikeEvidence(config: SpikeConfig): Promise<SpikeRunEvidence> {
  let preferenceEvidence = initialPreferenceEvidence(config.udid);
  let cells: Awaited<ReturnType<typeof runSpikeCells>> = [];
  let protocolProbes: SpikeResponse[] = [];
  let protocolProbeLogs: SpikeReport['protocolProbeLogs'] = [];
  let positiveControl = deepButtonFixtureEvidence();
  let adapters: readonly AcquisitionAdapter[] = [];
  try {
    positiveControl = runDeepButtonControls(config.repoRoot);
    preferenceEvidence = runPreferenceExperiment(config);
    assertPreferenceRestored(config, preferenceEvidence);
    adapters = createAdapters(config);
    bootSimulator(config.udid);
    primeFixtureApps(config);
    const probes = await runProtocolProbes(config, adapters);
    protocolProbes = probes.responses;
    protocolProbeLogs = probes.logs;
    cells = await runSpikeCells(config, supportedAdapters(adapters, protocolProbes));
    return collectedEvidence(
      'completed',
      cells,
      protocolProbes,
      protocolProbeLogs,
      preferenceEvidence,
      positiveControl,
    );
  } catch (error) {
    return {
      ...collectedEvidence(
        'stopped',
        cells,
        protocolProbes,
        protocolProbeLogs,
        preferenceEvidence,
        positiveControl,
      ),
      stop: stopForError(error),
    };
  } finally {
    await closeAdapters(adapters);
    cleanupDevice(config);
  }
}

async function closeAdapters(adapters: readonly AcquisitionAdapter[]): Promise<void> {
  for (const adapter of adapters) await adapter.close?.();
}

function collectedEvidence(
  status: SpikeReport['status'],
  cells: SpikeReport['cells'],
  protocolProbes: SpikeResponse[],
  protocolProbeLogs: SpikeReport['protocolProbeLogs'],
  preferenceEvidence: PreferenceEvidence,
  positiveControl: SpikeReport['positiveControl'],
): SpikeRunEvidence {
  return {
    status,
    cells,
    protocolProbes,
    protocolProbeLogs,
    preferenceEvidence,
    positiveControl,
  };
}

function assertPreferenceRestored(config: SpikeConfig, evidence: PreferenceEvidence): void {
  if (config.applyPreferences && !evidence.restored) {
    throw new Error('The task-owned Simulator preference experiment was not restored.');
  }
}

function cleanupDevice(config: SpikeConfig): void {
  if (!config.keepDevice) shutdownSimulator(config.udid);
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
    guestMechanism: GUEST_MECHANISM_EVIDENCE,
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
    corpusCoverage: corpusCoverage(
      config.states,
      config.screens,
      evidence.cells,
      config.candidates,
    ),
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
  return config.candidates.map((candidate) => {
    if (candidate === 'guest-simulator-framework-bridge') {
      return createGuestSimulatorFrameworkBridgeAdapter(options);
    }
    return createXCTestControlAdapter((request) => ({
      repoRoot: config.repoRoot,
      stateDir: config.stateDir,
      session: `ax-spike-xctest-control-${request.state}-${request.screen}`,
      udid: request.simulatorUdid,
      derivedPath: path.join(config.derivedPath, 'xctest-control', request.screen),
    }));
  });
}

async function runProtocolProbes(
  config: SpikeConfig,
  adapters: readonly AcquisitionAdapter[],
): Promise<{ responses: SpikeResponse[]; logs: SpikeReport['protocolProbeLogs'] }> {
  const responses: SpikeResponse[] = [];
  const logs: ProtocolProbeLog[] = [];
  for (const adapter of adapters) {
    if (adapter.candidate !== 'guest-simulator-framework-bridge') continue;
    const request = protocolProbeRequest(config);
    const result = await adapter.acquireBatch([request]);
    responses.push(...result.responses.slice(0, 1));
    logs.push({
      candidate: 'guest-simulator-framework-bridge',
      id: request.id,
      stderr: result.stderr,
    });
  }
  return { responses, logs };
}

function protocolProbeRequest(config: SpikeConfig): SpikeRequest {
  return {
    version: 1,
    id: 'protocol-probe:guest-simulator-framework-bridge',
    candidate: 'guest-simulator-framework-bridge',
    simulatorUdid: config.udid,
    state: 'warm',
    screen: 'unprepared-surface',
    limits: config.limits,
  };
}

function readMetadata(config: SpikeConfig): {
  target: SpikeReport['target'];
  toolchain: Toolchain;
} {
  const target = readTarget(config.udid, 'com.callstack.agentdevicelab');
  return {
    target: { udid: target.udid, name: target.name, runtime: target.runtime },
    toolchain: readToolchain(),
  };
}

function supportedAdapters(
  adapters: readonly AcquisitionAdapter[],
  probes: readonly SpikeResponse[],
): readonly AcquisitionAdapter[] {
  return adapters.filter((adapter) => {
    if (adapter.candidate === 'xctest-control') return true;
    const probe = probes.find((candidate) => candidate.candidate === adapter.candidate);
    return ![
      'guest-tool-unavailable',
      'guest-companion-start-timeout',
      'guest-companion-spawn-failed',
      'guest-companion-exited-before-ready',
      'host-accessibility-permission',
      'candidate-not-supported',
    ].includes(probe?.failure?.code ?? '');
  });
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
