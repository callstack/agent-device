// Change-coupling report — do the physical families match how the repo actually changes?
//
//   node --experimental-strip-types scripts/coupling/build.ts [--since-days <n>] [--out <path>]
//
// Logical coupling from git history alone: co-change affinity between production files, family
// modularity against the size-matched expectation, and how many families one commit spans.
// Families and the file set come from the layering gate (`scripts/layering/`); history comes
// from `scripts/repo-history/`. Report-only: nothing here gates, ratchets, or allowlists.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { targetDagZone } from '../layering/model.ts';
import { loadRepoHistory } from '../repo-history/load.ts';
import { buildCouplingReport, formatCouplingSummary } from './report.ts';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

const USAGE =
  'Usage: pnpm coupling [--since-days <n>] [--out <path>] [--limit <n>]\n' +
  '\n' +
  '  --since-days  trailing window in days for the second measurement (default 120)\n' +
  '  --out         report path (default .tmp/coupling/report.json)\n' +
  '  --limit       entries per list in the text summary (default 10)\n';

function headCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function positiveInteger(flag: string, value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  throw new Error(`${flag} expects a positive integer, got ${JSON.stringify(value)}\n${USAGE}`);
}

function runCoupling(argv: readonly string[]): number {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'since-days': { type: 'string' },
      out: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const sinceDays = positiveInteger('--since-days', values['since-days'], 120);
  const limit = positiveInteger('--limit', values.limit, 10);
  const jsonPath = values.out
    ? path.resolve(values.out)
    : path.join(repoRoot, '.tmp/coupling/report.json');

  const history = loadRepoHistory(repoRoot);
  const report = buildCouplingReport(history, {
    familyOf: targetDagZone,
    sinceDays,
    now: new Date(),
    generated: { commit: headCommit(), date: new Date().toISOString() },
  });
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(formatCouplingSummary(report, limit));
  process.stdout.write(`  wrote ${path.relative(repoRoot, jsonPath)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = runCoupling(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`coupling: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
