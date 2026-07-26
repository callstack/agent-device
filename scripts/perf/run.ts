import fs from 'node:fs';
import path from 'node:path';
import { parseConfig, REPO_ROOT, usesSourceCli } from './config.ts';
import { runScenario, setupIsolation, teardownIsolation, type IsolationContext } from './harness.ts';
import { writeReports } from './report.ts';
import type { RunResult } from './types.ts';

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function main(): void {
  const cfg = parseConfig(process.argv.slice(2));
  // The dist binary needs a build; running from source (AGENT_DEVICE_PERF_CLI) does not.
  if (!usesSourceCli() && !fs.existsSync(path.join(REPO_ROOT, 'dist', 'src'))) {
    process.stderr.write('[perf] dist/ is missing — run `pnpm build` first.\n');
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  let ctx: IsolationContext | null = null;
  let exitCode = 0;

  const cleanup = (): void => {
    if (ctx) {
      teardownIsolation(ctx, cfg);
      ctx = null;
    }
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  try {
    ctx = setupIsolation(cfg);
    const measurements = runScenario(ctx, cfg);
    const run: RunResult = {
      startedAt,
      finishedAt: new Date().toISOString(),
      platform: cfg.platform,
      device: { udid: ctx.profile.udid, serial: ctx.profile.serial, name: ctx.profile.deviceName },
      config: { rounds: cfg.rounds, warmup: cfg.warmup, keepArtifacts: cfg.keepArtifacts },
      agentDeviceVersion: readVersion(),
      measurements,
    };
    const { jsonPath, mdPath } = writeReports(run, cfg.outDir);
    process.stderr.write(`\n[perf] report: ${mdPath}\n[perf] json:   ${jsonPath}\n`);
  } catch (e) {
    process.stderr.write(`[perf] error: ${(e as Error).stack ?? String(e)}\n`);
    exitCode = 1;
  } finally {
    cleanup();
  }
  process.exit(exitCode);
}

main();
