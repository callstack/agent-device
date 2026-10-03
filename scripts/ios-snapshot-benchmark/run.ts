import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BenchmarkConfigurationError,
  parseConfig,
  type BenchmarkConfig,
} from './benchmark-config.ts';
import { classifyFailure, formatCliFailure, openFixture, type CliContext } from './command.ts';
import { BenchmarkControlError, runDeepButtonControls } from './deep-control.ts';
import { CONTRACT, screenFixture } from './definitions.ts';
import { deepButtonFixtureEvidence } from './deep-button.ts';
import { readGitRevision, readHostIdentity, readTarget, readToolchain } from './host.ts';
import {
  BenchmarkCellAdmissionError,
  BenchmarkContentionError,
  BenchmarkInfrastructureError,
  bootSimulator,
  shutdownSimulator,
  stopDaemon,
} from './lifecycle.ts';
import { closeSession, runLocalMeasurements } from './local-runner.ts';
import { measurePackageSize, notRunPackageSize } from './package-evidence.ts';
import { runProxyMeasurements } from './proxy-runner.ts';
import { renderBenchmarkMarkdown } from './report.ts';
import { assertValidRawResult } from './schema.ts';
import {
  BENCHMARK_SCHEMA_VERSION,
  type BenchmarkStop,
  type BenchmarkResult,
  type DeepButtonEvidence,
  type GitRevision,
  type HostIdentity,
  type Measurement,
  type PackageSize,
  type ProxyNetwork,
  type Target,
  type Toolchain,
} from './types.ts';

type BenchmarkMetadata = {
  revision: GitRevision;
  target: Target;
  toolchain: Toolchain;
  host: HostIdentity;
};
type BenchmarkEvidence = {
  packageSize: PackageSize;
  deepButtonEvidence: DeepButtonEvidence;
  measurements: Measurement[];
  proxyNetworks?: ProxyNetwork[];
};

if (isMainModule()) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

async function main(argv: string[]): Promise<void> {
  const config = parseConfig(argv);
  const metadata = readMetadata(config);
  const result = await executeBenchmark(config, metadata);
  assertValidRawResult(result);
  writeResult(config.outputPath, result);
  process.stdout.write(`${renderBenchmarkMarkdown(result)}\nraw: ${config.outputPath}\n`);
  if (result.status === 'stopped') process.exitCode = 2;
}

function readMetadata(config: BenchmarkConfig): BenchmarkMetadata {
  return {
    revision: readGitRevision(config.repoRoot),
    target: readTarget(config.udid, config.appId, config.appPath),
    toolchain: readToolchain(),
    host: readHostIdentity(),
  };
}

async function executeBenchmark(
  config: BenchmarkConfig,
  metadata: BenchmarkMetadata,
): Promise<BenchmarkResult> {
  const evidence: BenchmarkEvidence = {
    packageSize: notRunPackageSize(metadata.revision.commit),
    deepButtonEvidence: deepButtonFixtureEvidence(),
    measurements: [],
  };
  try {
    bootSimulator(config.udid);
    primeDeepLink(config);
    evidence.deepButtonEvidence = runDeepButtonControls(config.repoRoot);
    if (!config.skipPackageSize) {
      evidence.packageSize = measurePackageSize(config.repoRoot, metadata.revision.commit);
    }
    const measurements = await collectMeasurements(config);
    evidence.measurements = measurements.measurements;
    evidence.proxyNetworks = measurements.proxyNetworks;
    return completedResult(config, metadata, evidence);
  } catch (error) {
    return stoppedResult(config, metadata, evidence, error);
  } finally {
    shutdownAfterRun(config);
  }
}

function primeDeepLink(config: BenchmarkConfig): void {
  const fixture = config.screens.map(screenFixture).find((candidate) => candidate.launchUrl);
  if (!fixture) return;
  const context: CliContext = {
    repoRoot: config.repoRoot,
    stateDir: config.stateDir,
    session: 'bench-deep-link-prime',
    udid: config.udid,
    derivedPath: path.join(config.derivedPath, 'deep-link-prime'),
  };
  try {
    const opened = openFixture(context, fixture, { relaunch: true });
    if (!opened.ok) {
      throw new BenchmarkInfrastructureError(
        formatCliFailure('deep-link priming', classifyFailure(opened.payload, opened), opened),
        'agent-device open --launch-url',
      );
    }
  } finally {
    closeSession(context);
    stopDaemon(config.repoRoot, config.stateDir);
  }
}

async function collectMeasurements(config: BenchmarkConfig): Promise<{
  measurements: Measurement[];
  proxyNetworks?: ProxyNetwork[];
}> {
  const measurements = shouldRunLocal(config)
    ? await runLocalMeasurements({
        repoRoot: config.repoRoot,
        stateDir: config.stateDir,
        derivedPath: config.derivedPath,
        udid: config.udid,
        fixtures: config.screens.map(screenFixture),
        states: config.states,
        samples: config.samples,
      })
    : [];
  if (!shouldRunProxy(config)) return { measurements };
  const proxy = await runProxyMeasurements({
    repoRoot: config.repoRoot,
    stateDir: path.join(config.stateDir, 'proxy'),
    clientStateDir: path.join(config.stateDir, 'proxy-clients'),
    derivedPath: config.derivedPath,
    udid: config.udid,
    fixtures: config.screens.map(screenFixture),
    samples: config.samples,
    rtts: config.rtts,
    bandwidthKbps: config.bandwidthKbps,
    packetLossPercent: config.packetLossPercent,
    seed: config.seed,
  });
  return { measurements: [...measurements, ...proxy.measurements], proxyNetworks: proxy.networks };
}

function shouldRunLocal(config: BenchmarkConfig): boolean {
  return config.mode === 'local' || config.mode === 'all';
}

function shouldRunProxy(config: BenchmarkConfig): boolean {
  return config.mode === 'proxy' || config.mode === 'all';
}

function completedResult(
  config: BenchmarkConfig,
  metadata: BenchmarkMetadata,
  evidence: BenchmarkEvidence,
): BenchmarkResult {
  return {
    ...resultFields(config, metadata, evidence),
    status: 'completed',
    measurements: evidence.measurements,
    ...(evidence.proxyNetworks ? { proxyNetworks: evidence.proxyNetworks } : {}),
  };
}

function stoppedResult(
  config: BenchmarkConfig,
  metadata: BenchmarkMetadata,
  evidence: BenchmarkEvidence,
  error: unknown,
): BenchmarkResult {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[ios-benchmark] stopped: ${message}\n`);
  return {
    ...resultFields(config, metadata, evidence),
    status: 'stopped',
    measurements: evidence.measurements,
    ...(evidence.proxyNetworks ? { proxyNetworks: evidence.proxyNetworks } : {}),
    stop: {
      category: stopCategory(error),
      message: message.slice(0, 2000),
      ...stopDetails(error),
    },
  };
}

function stopDetails(error: unknown): Pick<BenchmarkStop, 'reason' | 'command'> {
  const reason = error instanceof BenchmarkCellAdmissionError ? error.reason : undefined;
  const command = stopCommand(error);
  return {
    ...(reason ? { reason } : {}),
    ...(command ? { command } : {}),
  };
}

function stopCategory(error: unknown): 'infrastructure' | 'contention' | 'configuration' {
  if (error instanceof BenchmarkConfigurationError) return 'configuration';
  if (error instanceof BenchmarkContentionError) return 'contention';
  return 'infrastructure';
}

function stopCommand(error: unknown): string | undefined {
  if (
    error instanceof BenchmarkControlError ||
    error instanceof BenchmarkInfrastructureError ||
    error instanceof BenchmarkContentionError
  ) {
    return error.command;
  }
  return undefined;
}

function shutdownAfterRun(config: BenchmarkConfig): void {
  if (config.keepDevice) return;
  try {
    shutdownSimulator(config.udid);
  } catch {
    process.stderr.write(`[ios-benchmark] cleanup could not shut down ${config.udid}\n`);
  }
}

function resultFields(
  config: BenchmarkConfig,
  metadata: BenchmarkMetadata,
  evidence: BenchmarkEvidence,
) {
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    issue: CONTRACT.issue,
    parent: CONTRACT.parent,
    references: CONTRACT.references,
    runId: `ios-snapshot-${Date.now()}-${process.pid}`,
    generatedAt: new Date().toISOString(),
    revision: metadata.revision,
    toolchain: metadata.toolchain,
    host: metadata.host,
    target: metadata.target,
    config: {
      warmSampleMinimum: CONTRACT.warmSampleMinimum,
      coldSampleMinimum: CONTRACT.coldSampleMinimum,
      requestedSamples: config.samples,
      screens: config.screens,
      states: config.states,
    },
    measurements: [],
    packageSize: evidence.packageSize,
    deepButtonEvidence: evidence.deepButtonEvidence,
  } satisfies Omit<BenchmarkResult, 'status' | 'stop' | 'proxyNetworks'>;
}

function writeResult(outputPath: string, result: BenchmarkResult): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(outputPath.replace(/\.json$/u, '.md'), renderBenchmarkMarkdown(result));
}

function isMainModule(): boolean {
  return Boolean(
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)),
  );
}
