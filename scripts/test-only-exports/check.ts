// Ratchet against exports reachable only from test files. See PR #1202 for
// rationale and the fallow --production two-pass design. Known limitation:
// dynamic property access (obj[name]) is invisible to fallow's import graph
// and to the own-file identifier count — the same blind spot as fallow's own
// dead-code check; annotate such exports as test seams or use ignoreExports.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSync } from 'oxc-parser';

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

export type CheckOptions = {
  root: string;
  fallowBin: string;
};

const ANNOTATION_LOOKBACK_LINES = 2;
const TEST_SEAM_ANNOTATION = /^\/\/\s*test-seam:\s*\S/;

const scriptRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function defaultOptions(): CheckOptions {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  return { root, fallowBin: path.join(scriptRepoRoot, 'node_modules/.bin/fallow') };
}

function baselinePathFor(root: string): string {
  return path.join(root, 'scripts/test-only-exports-baseline.json');
}

function isIdentifierNodeNamed(record: Record<string, unknown>, identifier: string): boolean {
  return (
    typeof record.type === 'string' &&
    record.type.includes('Identifier') &&
    record.name === identifier &&
    typeof record.start === 'number'
  );
}

// Spans dedupe aliased AST nodes: `export { x }` puts two Identifier nodes
// (local + exported) on the same source token, which must count once.
function collectIdentifierSpans(node: unknown, identifier: string, spans: Set<number>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectIdentifierSpans(child, identifier, spans);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (isIdentifierNodeNamed(record, identifier)) spans.add(record.start as number);
  for (const key of Object.keys(record)) {
    if (key !== 'type') collectIdentifierSpans(record[key], identifier, spans);
  }
}

// AST-level identifier count via oxc-parser, so mentions of the export's
// name inside comments, JSDoc, strings, and template-literal text do not
// count as occurrences (a regex over raw source miscounts all of those).
// Returns undefined when the file does not parse.
export function countIdentifierOccurrences(
  filePath: string,
  source: string,
  identifier: string,
): number | undefined {
  const result = parseSync(filePath, source);
  if (result.errors.length > 0) return undefined;
  const spans = new Set<number>();
  collectIdentifierSpans(result.program, identifier, spans);
  return spans.size;
}

function runFallowDeadCode(
  options: CheckOptions,
  extraArgs: readonly string[],
): FallowDeadCodeReport {
  const args = ['dead-code', '--unused-exports', '--format', 'json', '-q', ...extraArgs];
  try {
    return JSON.parse(
      execFileSync(options.fallowBin, args, { cwd: options.root, encoding: 'utf8' }),
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

function readSourceLines(root: string, filePath: string): string[] | undefined {
  try {
    return fs.readFileSync(path.join(root, filePath), 'utf8').split('\n');
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

// A same-file identifier occurrence beyond the declaration is a real call
// site: the export keyword is redundant, but it isn't the #1199 shape.
function hasOwnFileCallSite(filePath: string, lines: string[], exportName: string): boolean {
  const occurrences = countIdentifierOccurrences(filePath, lines.join('\n'), exportName);
  // CONSERVATIVE: an unparseable file cannot be inspected for same-file call
  // sites, so treat it as called rather than fabricate a finding on it.
  // Revisit if src/ ever intentionally contains non-TS/JS sources that
  // fallow still reports exports for.
  if (occurrences === undefined) return true;
  return occurrences > 1;
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

function isAnnotatedOrCalledInFile(root: string, entry: FallowUnusedExport): boolean {
  const lines = readSourceLines(root, entry.path);
  // CONSERVATIVE: treat an unreadable source file as annotated/called so a
  // transient read failure cannot fabricate a finding and fail CI on a file
  // nobody touched. Revisit if fallow ever reports paths that are not
  // repo-relative files on disk.
  if (!lines) return true;
  return (
    isAnnotatedTestSeam(lines, entry.line) ||
    hasOwnFileCallSite(entry.path, lines, entry.export_name)
  );
}

function isOnlyReachableFromTests(
  options: CheckOptions,
  entry: FallowUnusedExport,
  defaultReport: FallowDeadCodeReport,
): boolean {
  const guards = [
    entry.is_type_only,
    isDeadInDefaultGraphToo(entry, defaultReport),
    isAnnotatedOrCalledInFile(options.root, entry),
  ];
  return !guards.some(Boolean);
}

export function computeTestOnlyExports(options: CheckOptions): Finding[] {
  const defaultReport = runFallowDeadCode(options, []);
  const productionReport = runFallowDeadCode(options, ['--production']);

  return productionReport.unused_exports
    .filter((entry) => isOnlyReachableFromTests(options, entry, defaultReport))
    .map((entry) => ({ path: entry.path, export: entry.export_name, line: entry.line }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.export.localeCompare(b.export));
}

function readBaseline(baselinePath: string): Finding[] {
  if (!fs.existsSync(baselinePath)) return [];
  return JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Finding[];
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

function reportNewFindings(added: readonly Finding[]): void {
  process.stderr.write(
    `test-only-exports: ${added.length} NEW test-only export(s) not in baseline\n\n`,
  );
  for (const f of added) reportNewFinding(f);
  process.stderr.write(
    `\nFix it in this diff (wire it up or delete it), or add ` +
      `'// test-seam: <reason>' above the export if this is intentional.\n`,
  );
}

function reportShrinkable(root: string, removed: readonly Finding[]): void {
  if (removed.length === 0) return;
  const noun = removed.length === 1 ? 'entry is' : 'entries are';
  process.stdout.write(
    `test-only-exports: ${removed.length} baseline ${noun} no longer test-only — ` +
      `run \`pnpm check:test-only-exports:baseline\` to shrink the baseline:\n`,
  );
  for (const f of removed) process.stdout.write(`    - ${f.path}:${f.export}\n`);
  process.stdout.write(
    `::warning file=${path.relative(root, baselinePathFor(root))},title=Stale test-only-exports baseline::` +
      `${removed.length} baseline ${noun} no longer test-only ` +
      `(${removed.map(findingKey).join(', ')}). Run pnpm check:test-only-exports:baseline to shrink the baseline.\n`,
  );
}

function subtractByKey(from: readonly Finding[], subtracted: readonly Finding[]): Finding[] {
  const keys = new Set(subtracted.map(findingKey));
  return from.filter((f) => !keys.has(findingKey(f)));
}

function report(root: string, live: readonly Finding[], baseline: readonly Finding[]): number {
  const added = subtractByKey(live, baseline);
  if (added.length > 0) {
    reportNewFindings(added);
    return 1;
  }

  process.stdout.write(
    `test-only-exports: OK — ${live.length} known test-only export(s), 0 new.\n`,
  );
  reportShrinkable(root, subtractByKey(baseline, live));
  return 0;
}

// The baseline is shrink-only: this refuses to accept new findings, so the
// only reviewable acceptance path for a new test-only export is the
// `// test-seam: <reason>` annotation in the source diff. Growing the
// baseline requires a deliberate manual edit (expected only for mass
// migrations of the check itself).
function updateBaseline(
  live: readonly Finding[],
  baseline: readonly Finding[],
  baselinePath: string,
): number {
  const added = subtractByKey(live, baseline);
  if (added.length > 0) {
    reportNewFindings(added);
    process.stderr.write(
      `\ntest-only-exports: --update-baseline only removes entries; it cannot accept new findings.\n`,
    );
    return 1;
  }
  fs.writeFileSync(baselinePath, `${JSON.stringify(live, null, 2)}\n`);
  const removed = baseline.length - live.length;
  process.stdout.write(
    `test-only-exports: wrote ${live.length} entries to ${baselinePath} (removed ${removed}).\n`,
  );
  return 0;
}

export function main(argv = process.argv.slice(2)): number {
  const options = defaultOptions();
  const baselinePath = baselinePathFor(options.root);
  const live = computeTestOnlyExports(options);
  const baseline = readBaseline(baselinePath);
  if (argv.includes('--update-baseline')) {
    return updateBaseline(live, baseline, baselinePath);
  }
  return report(options.root, live, baseline);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
