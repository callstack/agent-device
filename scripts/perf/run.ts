import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, REPO_ROOT, type PerfConfig } from './config.ts';
import { collectMetadata } from './metadata.ts';
import { writeRunOutput } from './report.ts';
import {
  describeCoverage,
  FIXTURE_APP_EVENT_URL_TEMPLATE,
  SUITE_EXCLUSIONS,
  suiteFor,
  type SuiteScenario,
} from './suite.ts';
import { runFinalizer, runSuite, type SuiteContext } from './suite-harness.ts';
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

function selectScenarios(cfg: PerfConfig): SuiteScenario[] {
  const suite = suiteFor(cfg.platform);
  if (!cfg.scenarios) return suite;
  const unknown = cfg.scenarios.filter((id) => !suite.some((s) => s.id === id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown scenarios: ${unknown.join(', ')} (known: ${suite.map((s) => s.id).join(', ')})`,
    );
  }
  return suite.filter((s) => cfg.scenarios!.includes(s.id));
}

async function runPlatformSuite(
  cfg: PerfConfig,
): Promise<{ measurements: Measurement[]; coverage: PerfSummary['coverage'] }> {
  const scenarios = selectScenarios(cfg);
  // The daemon inherits these from the first CLI call; they route trigger-app-event to the fixture.
  process.env.AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE ??= FIXTURE_APP_EVENT_URL_TEMPLATE;
  process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE ??= FIXTURE_APP_EVENT_URL_TEMPLATE;
  const rawDir = path.join(cfg.outDir, 'raw');
  const ctx: SuiteContext = {
    platform: cfg.platform,
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-perf-')),
    device: cfg.platform === 'ios' ? cfg.udid! : cfg.serial!,
    appId: cfg.appId,
    artifactsDir: path.join(rawDir, 'artifacts'),
    rawDir,
  };
  fs.mkdirSync(ctx.artifactsDir, { recursive: true });
  log(`state-dir: ${ctx.stateDir}`);
  const finalize = runFinalizer(ctx, cfg.keepArtifacts);
  onInterrupt(finalize);
  try {
    const measurements = await runSuite(ctx, cfg, scenarios);
    return {
      measurements,
      coverage: describeCoverage(scenarios, SUITE_EXCLUSIONS[cfg.platform]),
    };
  } finally {
    finalize();
  }
}

async function main(): Promise<void> {
  const cfg = parseConfig(process.argv.slice(2));
  // The CLI and the iOS forced-backend probe run from the build.
  if (!fs.existsSync(path.join(REPO_ROOT, 'dist', 'src'))) {
    throw new Error('dist/ is missing — run `pnpm build` first.');
  }
  const startedAt = new Date().toISOString();
  // Read before the run, so a checkout change during a long run cannot relabel it.
  const metadata = collectMetadata(cfg);
  const { measurements, coverage } = await runPlatformSuite(cfg);
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
