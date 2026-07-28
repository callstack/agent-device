// CI entrypoint for the contention single-retry policy (#1419).
//
//   node --experimental-strip-types scripts/lib/contention-retry-run.ts --coverage
//
// Runs Vitest once; if the only failures are timeout-shaped and live in the
// enumerated retry list (scripts/lib/contention-retry.ts), reruns exactly those
// files once. Every retried file is named in the job summary, and the run writes
// the shared scheduled-lane envelope so retry counts feed lane health (#1430).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runCmdStreaming, runCmdSync } from '../../src/utils/exec.ts';
import { parseScriptArgs } from './cli-args.ts';
import { runWithContentionRetry, type TestRun } from './contention-retry-lane.ts';
import { normalizeTestFile, type TestFailure } from './contention-retry.ts';

const USAGE = `Usage: node --experimental-strip-types scripts/lib/contention-retry-run.ts [options]

  --coverage         Run the full suite under coverage (the CI Coverage job)
  --project <a,b>    Vitest projects for the first run (default: all)
  --report <file>    Vitest JSON report path (default: .tmp/contention-retry/report.json)
  --envelope <file>  Lane envelope path (default: .tmp/contention-retry/lane-envelope.json)
  --summary <file>   Markdown summary sink (default: $GITHUB_STEP_SUMMARY)
`;

const repoRoot = path.resolve(import.meta.dirname, '../..');
const DEFAULT_REPORT = '.tmp/contention-retry/report.json';
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

function reporterArgs(report: string): string[] {
  return ['--reporter=default', '--reporter=json', `--outputFile.json=${report}`];
}

async function runVitest(extra: string[], report: string): Promise<TestRun> {
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.rmSync(report, { force: true });
  const result = await runCmdStreaming(
    'pnpm',
    ['exec', 'vitest', 'run', ...extra, ...reporterArgs(report)],
    {
      cwd: repoRoot,
      allowFailure: true,
      onStdoutChunk: (chunk) => process.stdout.write(chunk),
      onStderrChunk: (chunk) => process.stderr.write(chunk),
    },
  );
  return { ok: result.exitCode === 0, failures: readFailures(report) };
}

/**
 * Vitest's JSON reporter, narrowed at the trust boundary. A run that dies before
 * writing a report yields no failures, which the policy reads as "nothing
 * retry-eligible" — the job fails, which is the safe direction.
 */
function readFailures(report: string): readonly TestFailure[] {
  if (!fs.existsSync(report)) return [];
  const parsed: unknown = JSON.parse(fs.readFileSync(report, 'utf8'));
  const suites = (parsed as { testResults?: unknown }).testResults;
  if (!Array.isArray(suites)) return [];
  const failures: TestFailure[] = [];
  for (const suite of suites) {
    const { name, assertionResults } = suite as {
      name?: unknown;
      assertionResults?: unknown;
    };
    if (typeof name !== 'string' || !Array.isArray(assertionResults)) continue;
    for (const assertion of assertionResults) {
      const { status, fullName, title, failureMessages } = assertion as {
        status?: unknown;
        fullName?: unknown;
        title?: unknown;
        failureMessages?: unknown;
      };
      if (status !== 'failed') continue;
      const messages = Array.isArray(failureMessages) ? failureMessages : [];
      failures.push({
        file: normalizeTestFile(name, repoRoot),
        testName: typeof fullName === 'string' ? fullName : String(title ?? 'unknown test'),
        message: messages.filter((message) => typeof message === 'string').join('\n'),
      });
    }
  }
  return failures;
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
  for (const file of ['vitest.config.ts', 'scripts/lib/contention-retry.ts']) {
    hash.update(fs.readFileSync(path.join(repoRoot, file)));
  }
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
}

const projects = (args.project ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .flatMap((name) => ['--project', name]);

const startedAtMs = Date.now();
const result = await runWithContentionRetry({
  runAll: () => runVitest([...projects, ...(args.coverage ? ['--coverage'] : [])], reportPath),
  // The rerun is file-scoped and coverage-free on purpose: coverage thresholds
  // are a whole-suite verdict, and a threshold miss is not timeout-shaped, so it
  // never reaches this branch.
  runFiles: (files) => runVitest([...files], `${reportPath}.retry.json`),
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
