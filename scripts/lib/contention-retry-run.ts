// CI entrypoint for the contention single-retry policy (#1419).
//
//   node --experimental-strip-types scripts/lib/contention-retry-run.ts --coverage
//
// Runs Vitest once; if the only failures are timeout-shaped and live in the
// enumerated retry list (scripts/lib/contention-retry.ts), reruns exactly those
// files once. Every retried file is named in the job summary, and the run writes
// the shared lane envelope (scripts/lib/lane-envelope.ts) so retry counts stay observable.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runCmdStreaming, runCmdSync } from '../../src/utils/exec.ts';
import { parseScriptArgs } from './cli-args.ts';
import { firstRunArgs, retryRunArgs, type RunModes } from './contention-retry-args.ts';
import { runWithContentionRetry, type TestRun } from './contention-retry-lane.ts';
import { FAILURE_FILE_ENV } from './contention-retry-reporter.ts';
import { RUNNER_TIMEOUT_TOKEN_ENV } from './runner-timeout-meta.ts';
import { processBlockers } from './contention-retry-blockers.ts';
import { parseFailureReport, type RunBlocker, type TestFailure } from './contention-retry.ts';

const USAGE = `Usage: node --experimental-strip-types scripts/lib/contention-retry-run.ts [options]

  --coverage         Run the full suite under coverage (the CI Coverage job)
  --project <a,b>    Vitest projects for the first run (default: all)
  --report <file>    Failure report path (default: .tmp/contention-retry/failures.json)
  --envelope <file>  Lane envelope path (default: .tmp/contention-retry/lane-envelope.json)
  --summary <file>   Markdown summary sink (default: $GITHUB_STEP_SUMMARY)
`;

const repoRoot = path.resolve(import.meta.dirname, '../..');
const DEFAULT_REPORT = '.tmp/contention-retry/failures.json';
const DEFAULT_ENVELOPE = '.tmp/contention-retry/lane-envelope.json';

const args = parseScriptArgs(process.argv.slice(2), USAGE, {
  coverage: { type: 'boolean', default: false },
  project: { type: 'string' },
  report: { type: 'string', default: DEFAULT_REPORT },
  envelope: { type: 'string', default: DEFAULT_ENVELOPE },
  summary: { type: 'string' },
});

const reportPath = path.resolve(repoRoot, args.report);
const envelopePath = path.resolve(repoRoot, args.envelope);
const summaryPath = args.summary ?? process.env.GITHUB_STEP_SUMMARY;

/** The capability the runner needs to mark a timeout; test modules never see it. */
const TIMEOUT_TOKEN = crypto.randomUUID();

async function runVitest(extra: string[], report: string): Promise<TestRun> {
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.rmSync(report, { force: true });
  let output = '';
  const capture = (chunk: string, write: (text: string) => void): void => {
    output += chunk;
    write(chunk);
  };
  const result = await runCmdStreaming('pnpm', ['exec', 'vitest', 'run', ...extra], {
    cwd: repoRoot,
    env: { ...process.env, [FAILURE_FILE_ENV]: report, [RUNNER_TIMEOUT_TOKEN_ENV]: TIMEOUT_TOKEN },
    allowFailure: true,
    onStdoutChunk: (chunk) => capture(chunk, (text) => process.stdout.write(text)),
    onStderrChunk: (chunk) => capture(chunk, (text) => process.stderr.write(text)),
  });
  const reported = readReport(report);
  const ok = result.exitCode === 0;
  return {
    ok,
    failures: reported.failures,
    blockers: [
      ...reported.blockers,
      ...processBlockers({ ok, output, failureCount: reported.failures.length }),
    ],
  };
}

function readReport(report: string): {
  failures: readonly TestFailure[];
  blockers: readonly RunBlocker[];
} {
  if (!fs.existsSync(report)) return { failures: [], blockers: [] };
  return parseFailureReport(JSON.parse(fs.readFileSync(report, 'utf8')), repoRoot);
}

function vitestVersion(): string {
  const manifest: unknown = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  const version = (manifest as { devDependencies?: Record<string, string> }).devDependencies
    ?.vitest;
  return version ?? 'unknown';
}

function configHash(): string {
  const hash = crypto.createHash('sha256');
  for (const file of [
    'vitest.config.ts',
    'scripts/lib/contention-retry.ts',
    'scripts/lib/contention-retry-args.ts',
    'scripts/lib/contention-retry-reporter.ts',
    'scripts/lib/contention-retry-blockers.ts',
    'scripts/lib/run-blocker-bus.ts',
    'scripts/vitest-runner-timeout-setup.ts',
  ]) {
    hash.update(fs.readFileSync(path.join(repoRoot, file)));
  }
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
}

const modes: RunModes = {
  projects: (args.project ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
  coverage: args.coverage,
};

const startedAtMs = Date.now();
const result = await runWithContentionRetry({
  runAll: () => runVitest(firstRunArgs(modes), reportPath),
  runFiles: (files) =>
    runVitest(retryRunArgs(modes, files), reportPath.replace(/\.json$/, '.retry.json')),
  commit: runCmdSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.trim(),
  configHash: configHash(),
  vitestVersion: vitestVersion(),
  startedAtMs,
});

fs.mkdirSync(path.dirname(envelopePath), { recursive: true });
fs.writeFileSync(envelopePath, `${JSON.stringify(result.envelope, null, 2)}\n`);

if (result.summary) {
  process.stdout.write(`\n${result.summary}`);
  if (summaryPath) fs.appendFileSync(summaryPath, result.summary);
}

process.exitCode = result.ok ? 0 : 1;
