import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { walkFiles } from '../lib/walk-files.ts';
import { runCmdSync } from '@agent-device/host-kit/command';

/**
 * Test-file size ratchet (AGENTS.md "Module and test topology": past 1,000 lines is architecture
 * debt, and tests are not exempt; a test file mirrors its source module and splits when the
 * source does).
 *
 * The slow-test ratchet keeps the unit suite's wall clock honest; this one keeps its files
 * readable in one bounded read. The rule is history-backed: every test file over the tripwire
 * may be no longer than it was at the merge-base with origin/main, and a file that did not
 * exist there may not cross the tripwire. Shrinking needs no gate edit; the merge-base is the
 * only record of the previous length.
 *
 * Catches: a >1,000-line test file growing, or a new one appearing.
 * Evidence: 26 test files were over the line when this landed (2026-08-18); the largest,
 *   `snapshot-handler.test.ts`, gained 55 lines in the PR before, under a rule with no gate.
 * Cost: one directory walk, a line count per test file, and one `git cat-file --batch` spawn
 *   for the files over the tripwire — well under a second.
 * Kill criterion: no test file under src/, packages/, test/, or scripts/ exceeds the tripwire at
 *   the merge-base; delete this file when that holds.
 */

const TRIPWIRE_LINES = 1_000;

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const TEST_ROOTS = ['src', 'packages', 'test', 'scripts'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-types', '.tmp']);
const TEST_FILE = /\.test\.(?:ts|tsx|mjs)$/;

function isTestFile(file: string): boolean {
  if (!TEST_FILE.test(file)) return false;
  return !path
    .relative(REPO_ROOT, file)
    .split(path.sep)
    .some((part) => SKIPPED_DIRECTORIES.has(part));
}

/** Line count as `wc -l` reports it: newline characters. */
function countLines(file: string): number {
  let lines = 0;
  for (const char of fs.readFileSync(file, 'utf8')) if (char === '\n') lines += 1;
  return lines;
}

/**
 * Line counts of the given repo paths at the merge-base with origin/main, following renames, in
 * one `git cat-file --batch` spawn. `undefined` = the file did not exist there.
 */
function baseLineCounts(paths: readonly string[]): ReadonlyMap<string, number | undefined> {
  if (paths.length === 0) return new Map();
  const mergeBase = runCmdSync('git', ['merge-base', 'origin/main', 'HEAD'], {
    cwd: REPO_ROOT,
    allowFailure: true,
  });
  if (mergeBase.exitCode !== 0) {
    throw new Error(
      'test-file size ratchet needs origin/main to read base lengths (git merge-base origin/main HEAD failed): ' +
        `${mergeBase.stderr.trim()}. Fetch origin/main; the gate does not skip.`,
    );
  }
  const base = mergeBase.stdout.trim();
  const renamedFrom = new Map<string, string>();
  const renames = runCmdSync(
    'git',
    ['diff', '--name-status', '--find-renames', '--diff-filter=R', base, '--', '*.test.*'],
    { cwd: REPO_ROOT },
  );
  for (const line of renames.stdout.split('\n')) {
    const [, from, to] = line.split('\t');
    if (from && to) renamedFrom.set(to, from);
  }
  const requests = paths.map((file) => `${base}:${renamedFrom.get(file) ?? file}`);
  const batch = runCmdSync('git', ['cat-file', '--batch'], {
    cwd: REPO_ROOT,
    stdin: `${requests.join('\n')}\n`,
    binaryStdout: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  return parseCatFileBatch(batch.stdoutBuffer ?? Buffer.alloc(0), paths);
}

/**
 * `<sha> blob <size>\n<size bytes>\n` per hit, `<request> missing\n` per miss, in request order.
 * Sizes are bytes, so this walks the raw buffer: a string offset drifts after the first file with
 * a multi-byte character (every test file with an em dash).
 */
function parseCatFileBatch(
  output: Buffer,
  paths: readonly string[],
): ReadonlyMap<string, number | undefined> {
  const counts = new Map<string, number | undefined>();
  let offset = 0;
  for (const file of paths) {
    const headerEnd = output.indexOf(0x0a, offset);
    const header = output.subarray(offset, headerEnd).toString('utf8');
    offset = headerEnd + 1;
    const blob = /^\S+ blob (\d+)$/.exec(header);
    if (!blob) {
      counts.set(file, undefined); // "<request> missing"
      continue;
    }
    const size = Number(blob[1]);
    let lines = 0;
    for (let index = offset; index < offset + size; index += 1) {
      if (output[index] === 0x0a) lines += 1;
    }
    offset += size + 1;
    counts.set(file, lines);
  }
  return counts;
}

/** The ratchet decision, separated from the filesystem so the test below can plant each red. */
function ratchetFindings(
  measured: ReadonlyMap<string, number>,
  baseLines: ReadonlyMap<string, number | undefined>,
  tripwire: number,
): string[] {
  const findings: string[] = [];
  for (const [file, lines] of [...measured].sort()) {
    if (lines <= tripwire) continue;
    const base = baseLines.get(file);
    if (base === undefined) {
      findings.push(
        `${file} is ${lines} lines and did not exist at the merge-base: a new test file may not cross the ${tripwire}-line tripwire.`,
      );
    } else if (lines > Math.max(base, tripwire)) {
      findings.push(
        `${file} is ${lines} lines, ${base} at the merge-base: a test file over the tripwire may not grow; split it along the source module it mirrors (docs/agents/testing.md).`,
      );
    }
  }
  return findings;
}

test('no test file over the tripwire is longer than at the merge-base, and no new file crosses it', () => {
  const measured = new Map<string, number>();
  for (const root of TEST_ROOTS) {
    for (const file of walkFiles(path.join(REPO_ROOT, root), isTestFile)) {
      measured.set(path.relative(REPO_ROOT, file).split(path.sep).join('/'), countLines(file));
    }
  }
  expect(measured.size).toBeGreaterThan(500);

  const overTripwire = [...measured]
    .filter(([, lines]) => lines > TRIPWIRE_LINES)
    .map(([file]) => file);
  const baseLines = baseLineCounts(overTripwire);
  expect(ratchetFindings(measured, baseLines, TRIPWIRE_LINES)).toEqual([]);
});

test('planted reds: growth, a new giant file, and a file crossing the tripwire each name their fix', () => {
  const baseLines = new Map<string, number | undefined>([
    ['a.test.ts', 1200],
    ['b.test.ts', 1500],
    ['fresh.test.ts', undefined],
    ['small.test.ts', 900],
  ]);
  expect(ratchetFindings(new Map([['a.test.ts', 1230]]), baseLines, 1000)).toEqual([
    'a.test.ts is 1230 lines, 1200 at the merge-base: a test file over the tripwire may not grow; split it along the source module it mirrors (docs/agents/testing.md).',
  ]);
  expect(ratchetFindings(new Map([['fresh.test.ts', 1400]]), baseLines, 1000)).toEqual([
    'fresh.test.ts is 1400 lines and did not exist at the merge-base: a new test file may not cross the 1000-line tripwire.',
  ]);
  expect(ratchetFindings(new Map([['small.test.ts', 1001]]), baseLines, 1000)).toEqual([
    'small.test.ts is 1001 lines, 900 at the merge-base: a test file over the tripwire may not grow; split it along the source module it mirrors (docs/agents/testing.md).',
  ]);
  // Allowed: unchanged, shrunk (with no gate edit), under the tripwire, or new and small.
  expect(
    ratchetFindings(
      new Map([
        ['a.test.ts', 1100],
        ['b.test.ts', 1500],
        ['small.test.ts', 1000],
        ['fresh.test.ts', 1000],
      ]),
      baseLines,
      1000,
    ),
  ).toEqual([]);
});

test('cat-file --batch output is parsed per request, in order, with misses as undefined', () => {
  // The dash is 3 bytes in UTF-8: the parser must count by bytes, not characters.
  const dashed = Buffer.from('a — b\nc\n', 'utf8');
  const output = Buffer.concat([
    Buffer.from(`abc blob ${dashed.length}\n`),
    dashed,
    Buffer.from('\nHEAD:missing.ts missing\ndef blob 6\nx\ny\nz\n\n'),
  ]);
  expect([...parseCatFileBatch(output, ['dashed.ts', 'missing.ts', 'xyz.ts'])]).toEqual([
    ['dashed.ts', 2],
    ['missing.ts', undefined],
    ['xyz.ts', 3],
  ]);
});
