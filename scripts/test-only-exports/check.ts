// Ratchet against exports reachable only from test files. See PR body for
// rationale and the fallow --production two-pass design.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type FallowUnusedExport = {
  path: string;
  export_name: string;
  line: number;
  col: number;
  is_type_only: boolean;
};

type FallowDeadCodeReport = {
  unused_exports: FallowUnusedExport[];
};

type Finding = {
  path: string;
  export: string;
  line: number;
};

const ANNOTATION_LOOKBACK_LINES = 2;
const TEST_SEAM_ANNOTATION = /^\/\/\s*test-seam:\s*\S/;

function stripLineComment(line: string): string {
  return line.replace(/(^|\s)\/\/.*$/, '$1');
}

function wordBoundaryOccurrences(lines: string[], identifier: string): number {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g');
  const code = lines.map(stripLineComment).join('\n');
  return code.match(pattern)?.length ?? 0;
}

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const baselinePath = path.join(repoRoot, 'scripts/test-only-exports-baseline.json');
const fallowBin = path.join(repoRoot, 'node_modules/.bin/fallow');

function runFallowDeadCode(extraArgs: readonly string[]): FallowDeadCodeReport {
  const args = ['dead-code', '--unused-exports', '--format', 'json', '-q', ...extraArgs];
  try {
    return JSON.parse(
      execFileSync(fallowBin, args, { cwd: repoRoot, encoding: 'utf8' }),
    ) as FallowDeadCodeReport;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (!stdout) throw error;
    return JSON.parse(stdout) as FallowDeadCodeReport;
  }
}

function findingKey(f: { path: string; export: string }): string {
  return `${f.path}:${f.export}`;
}

function readSourceLines(filePath: string): string[] | undefined {
  try {
    return fs.readFileSync(path.join(repoRoot, filePath), 'utf8').split('\n');
  } catch {
    return undefined;
  }
}

function isAnnotatedTestSeam(lines: string[], exportLine: number): boolean {
  for (let offset = 1; offset <= ANNOTATION_LOOKBACK_LINES; offset++) {
    const line = lines[exportLine - 1 - offset]?.trim();
    if (!line) continue;
    return TEST_SEAM_ANNOTATION.test(line);
  }
  return false;
}

function hasOwnFileCallSite(lines: string[], exportName: string): boolean {
  return wordBoundaryOccurrences(lines, exportName) > 1;
}

// dead in both graphs — fallow's own dead-code check already owns this
function isDeadInDefaultGraphToo(
  entry: FallowUnusedExport,
  defaultReport: FallowDeadCodeReport,
): boolean {
  return defaultReport.unused_exports.some(
    (d) => d.path === entry.path && d.export_name === entry.export_name,
  );
}

function isAnnotatedOrCalledInFile(entry: FallowUnusedExport): boolean {
  const lines = readSourceLines(entry.path);
  if (!lines) return true; // can't inspect the file — don't report on it
  return isAnnotatedTestSeam(lines, entry.line) || hasOwnFileCallSite(lines, entry.export_name);
}

function isOnlyReachableFromTests(
  entry: FallowUnusedExport,
  defaultReport: FallowDeadCodeReport,
): boolean {
  const guards = [
    entry.is_type_only,
    isDeadInDefaultGraphToo(entry, defaultReport),
    isAnnotatedOrCalledInFile(entry),
  ];
  return !guards.some(Boolean);
}

function computeTestOnlyExports(): Finding[] {
  const defaultReport = runFallowDeadCode([]);
  const productionReport = runFallowDeadCode(['--production']);

  return productionReport.unused_exports
    .filter((entry) => isOnlyReachableFromTests(entry, defaultReport))
    .map((entry) => ({ path: entry.path, export: entry.export_name, line: entry.line }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.export.localeCompare(b.export));
}

function readBaseline(): Finding[] {
  if (!fs.existsSync(baselinePath)) return [];
  return JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Finding[];
}

function writeBaseline(findings: readonly Finding[]): void {
  const sorted = [...findings].sort(
    (a, b) => a.path.localeCompare(b.path) || a.export.localeCompare(b.export),
  );
  fs.writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  process.stdout.write(
    `test-only-exports: wrote ${sorted.length} entries to ${path.relative(repoRoot, baselinePath)}\n`,
  );
}

function reportShrinkable(removed: readonly Finding[]): void {
  if (removed.length === 0) return;
  process.stdout.write(
    `test-only-exports: ${removed.length} baseline entr${removed.length === 1 ? 'y is' : 'ies are'} no longer test-only — ` +
      `run \`pnpm check:test-only-exports:baseline\` to shrink the baseline:\n`,
  );
  for (const f of removed) process.stdout.write(`    - ${f.path}:${f.export}\n`);
}

function reportNewFinding(f: Finding): void {
  process.stderr.write(`  ${f.path}:${f.line} — ${f.export}\n`);
  process.stderr.write(
    `::error file=${f.path},line=${f.line},title=New test-only export::` +
      `'${f.export}' is imported only by test files, never by production code. ` +
      `Wire it into a production call site, delete it, or annotate it with ` +
      `'// test-seam: <reason>' directly above the export if this is intentional.\n`,
  );
}

function report(live: readonly Finding[], baseline: readonly Finding[]): number {
  const baselineKeys = new Set(baseline.map(findingKey));
  const liveKeys = new Set(live.map(findingKey));
  const added = live.filter((f) => !baselineKeys.has(findingKey(f)));

  if (added.length === 0) {
    process.stdout.write(
      `test-only-exports: OK — ${live.length} known test-only export(s), 0 new.\n`,
    );
    reportShrinkable(baseline.filter((f) => !liveKeys.has(findingKey(f))));
    return 0;
  }

  process.stderr.write(
    `test-only-exports: ${added.length} NEW test-only export(s) not in baseline\n\n`,
  );
  for (const f of added) reportNewFinding(f);
  process.stderr.write(
    `\nFix it in this diff (wire it up or delete it), or add ` +
      `'// test-seam: <reason>' above the export if this is intentional.\n`,
  );
  return 1;
}

export function main(argv = process.argv.slice(2)): number {
  const live = computeTestOnlyExports();
  if (argv.includes('--update-baseline')) {
    writeBaseline(live);
    return 0;
  }
  return report(live, readBaseline());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
