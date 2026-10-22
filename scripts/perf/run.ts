import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, REPO_ROOT, usesSourceCli, type PerfConfig } from './config.ts';
import { runScenario, setupIsolation, teardownIsolation } from './harness.ts';
import { iosRunFinalizer, runIosSuite, type IosSuiteContext } from './ios-harness.ts';
import {
  describeCoverage,
  FIXTURE_APP_EVENT_URL_TEMPLATE,
  IOS_SUITE,
  IOS_SUITE_EXCLUSIONS,
} from './ios-suite.ts';
import { collectMetadata } from './metadata.ts';
import { writeRunOutput } from './report.ts';
import { PERF_SUMMARY_SCHEMA, type Measurement, type PerfSummary } from './types.ts';

function log(msg: string): void {
  process.stderr.write(`[perf] ${msg}\n`);
}

function onInterrupt(cleanup: () => void): void {
  process.once('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
}

function selectScenarios(cfg: PerfConfig) {
  if (!cfg.scenarios) return IOS_SUITE;
  const unknown = cfg.scenarios.filter((id) => !IOS_SUITE.some((s) => s.id === id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown scenarios: ${unknown.join(', ')} (known: ${IOS_SUITE.map((s) => s.id).join(', ')})`,
    );
  }
  return IOS_SUITE.filter((s) => cfg.scenarios!.includes(s.id));
}

async function runIos(
  cfg: PerfConfig,
): Promise<{ measurements: Measurement[]; coverage: PerfSummary['coverage'] }> {
  const scenarios = selectScenarios(cfg);
  // The daemon inherits this from the first CLI call; it routes trigger-app-event to the fixture.
  process.env.AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE ??= FIXTURE_APP_EVENT_URL_TEMPLATE;
  const rawDir = path.join(cfg.outDir, 'raw');
  const ctx: IosSuiteContext = {
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-perf-')),
    udid: cfg.udid!,
    appId: cfg.appId,
    artifactsDir: path.join(rawDir, 'artifacts'),
    rawDir,
  };
  fs.mkdirSync(ctx.artifactsDir, { recursive: true });
  log(`state-dir: ${ctx.stateDir}`);
  const finalize = iosRunFinalizer(ctx, cfg.keepArtifacts);
  onInterrupt(finalize);
  try {
    const measurements = await runIosSuite(ctx, cfg, scenarios);
    return { measurements, coverage: describeCoverage(scenarios, IOS_SUITE_EXCLUSIONS) };
  } finally {
    finalize();
  }
}

function runAndroid(cfg: PerfConfig): {
  measurements: Measurement[];
  coverage: PerfSummary['coverage'];
} {
  const ctx = setupIsolation(cfg);
  onInterrupt(() => teardownIsolation(ctx, cfg));
  try {
    const measurements = runScenario(ctx, cfg);
    return {
      measurements,
      coverage: { measured: [...new Set(measurements.map((m) => m.command))].sort(), excluded: [] },
    };
  } finally {
    teardownIsolation(ctx, cfg);
  }
}

async function main(): Promise<void> {
  const cfg = parseConfig(process.argv.slice(2));
  // The iOS forced-backend probe loads the built SDK; the dist CLI needs the build as well.
  if (
    (cfg.platform === 'ios' || !usesSourceCli()) &&
    !fs.existsSync(path.join(REPO_ROOT, 'dist', 'src'))
  ) {
    throw new Error('dist/ is missing — run `pnpm build` first.');
  }
  const startedAt = new Date().toISOString();
  // Read before the run, so a checkout change during a long run cannot relabel it.
  const metadata = collectMetadata(cfg, cfg.serial ?? cfg.device ?? 'unknown');
  const { measurements, coverage } = cfg.platform === 'ios' ? await runIos(cfg) : runAndroid(cfg);
  const summary: PerfSummary = {
    schema: PERF_SUMMARY_SCHEMA,
    platform: cfg.platform,
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      rounds: cfg.rounds,
      warmup: cfg.warmup,
      scenarios: [...new Set(measurements.map((m) => m.scenario))],
    },
    metadata,
    coverage,
    measurements,
  };
  const { jsonPath, mdPath } = writeRunOutput(summary, cfg.outDir);
  log(`report: ${mdPath}`);
  log(`summary: ${jsonPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`[perf] error: ${(error as Error).stack ?? String(error)}\n`);
    process.exit(1);
  });
