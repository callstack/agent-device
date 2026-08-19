import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { walkFiles } from '../../scripts/lib/walk-files.ts';
import { runCmdSync } from '../utils/exec.ts';

/**
 * Test-file size ratchet (AGENTS.md "Scope & shape": past 1,000 lines is architecture debt,
 * and tests are not exempt; the topology rule says a test file mirrors its source module and
 * splits when the source does).
 *
 * The slow-test ratchet keeps the unit suite's wall clock honest; this one keeps its files
 * readable in one bounded read. Every test file over the tripwire is pinned at its exact
 * length, R9-style (#1781 A6): growing a pinned file fails ("split it, don't add to it"), and
 * shrinking one fails until the pin is lowered, so the list only ever ratchets down. A file
 * that drops under the tripwire leaves the list; a new file may not cross it.
 *
 * The pin map alone could be edited alongside the file (raise a pin and grow into it; add a
 * pin with a new giant file), so the gate is history-backed as well: every test file over the
 * tripwire may be no longer than it was at the merge-base with origin/main (or no longer than
 * the tripwire if it did not exist there), and no pin may exceed its file's base length. Both
 * pin-edit bypasses go red against git, not against the map.
 *
 * Catches: a >1,000-line test file growing (with or without a matching pin edit), or a new one
 *   appearing (with or without a pin).
 * Evidence: 26 test files were over the line when this landed (2026-08-18); the largest,
 *   `snapshot-handler.test.ts`, gained 55 lines in the PR before, under a rule with no gate.
 * Cost: one directory walk and a line count per test file — well under a second.
 * Kill criterion: the pin list is empty. Delete this file with the last pin.
 */

const TRIPWIRE_LINES = 1_000;

// Exact current lengths. Lower a pin when its file shrinks; never raise one — extract instead.
const PINNED_TEST_FILE_LINES: Readonly<Record<string, number>> = Object.freeze({
  'src/__tests__/remote-connection.test.ts': 2973,
  'src/daemon/handlers/__tests__/snapshot-handler.test.ts': 2310,
  'src/commands/interaction/runtime/settle.test.ts': 2361,
  'src/daemon/handlers/__tests__/session-replay-runtime-maestro.test.ts': 2031,
  'src/platforms/apple/core/__tests__/runner-session.test.ts': 2001,
  'src/utils/__tests__/daemon-client.test.ts': 1910,
  'src/utils/__tests__/output.test.ts': 1861,
  'src/platforms/android/__tests__/snapshot.test.ts': 1658,
  'src/platforms/apple/core/__tests__/runner-client.test.ts': 1615,
  'src/__tests__/client.test.ts': 1598,
  'test/integration/provider-scenarios/android-lifecycle.test.ts': 1559,
  'src/utils/__tests__/daemon-client-lifecycle.test.ts': 1414,
  'src/platforms/apple/core/__tests__/runner-command-retry.test.ts': 1327,
  'src/__tests__/cli-client-commands.test.ts': 1317,
  'src/__tests__/cli-config.test.ts': 1282,
  'src/daemon/handlers/__tests__/find.test.ts': 1207,
  'src/platforms/apple/core/__tests__/perf.test.ts': 1222,
  'src/mcp/__tests__/command-tools.test.ts': 1218,
  'src/daemon/handlers/__tests__/session-replay-divergence.test.ts': 1215,
  'src/platforms/apple/core/__tests__/apps.test.ts': 1210,
  'src/daemon/handlers/__tests__/session-replay-repair-transaction.test.ts': 1208,
  'src/daemon/snapshot-presentation/ios/presentation.test.ts': 1201,
  'src/daemon/handlers/__tests__/session-replay-target-verification-runtime.test.ts': 1183,
  'src/__tests__/client-metro.test.ts': 1105,
  'src/__tests__/cli-network.test.ts': 1092,
  'src/platforms/android/__tests__/snapshot-helper.test.ts': 1002,
});

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

/** The ratchet decision, separated from the filesystem so the tests below can plant each red. */
function ratchetFindings(
  measured: ReadonlyMap<string, number>,
  pinned: Readonly<Record<string, number>>,
  tripwire: number,
): string[] {
  const findings: string[] = [];
  for (const [file, lines] of [...measured].sort()) {
    const pin = pinned[file];
    if (pin === undefined) {
      if (lines > tripwire) {
        findings.push(
          `${file} is ${lines} lines, over the ${tripwire}-line tripwire and not pinned: split it ` +
            `along the source module it mirrors (docs/agents/testing.md) rather than pinning it.`,
        );
      }
      continue;
    }
    if (lines <= tripwire) {
      // Pins exist only for files over the tripwire: one on a smaller file grows the map for
      // nothing (900 pinned at 900 would satisfy equality and history alike) and defeats the
      // only-shrink kill criterion.
      findings.push(
        `${file} is ${lines} lines, at or under the ${tripwire}-line tripwire, but has a pin (${pin}): remove it — pins are only for files over the tripwire.`,
      );
      continue;
    }
    if (lines > pin) {
      findings.push(
        `${file} grew to ${lines} lines (pinned ${pin}): extract instead of adding to a file over the tripwire.`,
      );
    } else if (lines < pin) {
      findings.push(
        `${file} shrank to ${lines} lines (pinned ${pin}): lower its pin in this PR so the ratchet keeps the gain.`,
      );
    }
  }
  for (const file of Object.keys(pinned)) {
    if (!measured.has(file)) {
      findings.push(`${file} is pinned but does not exist: remove its pin.`);
    }
  }
  return findings;
}

/**
 * Line counts of the given repo paths at the merge-base with origin/main, following renames, in
 * one `git cat-file --batch` spawn. `undefined` = the file did not exist there.
 */
function baseLineCounts(paths: readonly string[]): ReadonlyMap<string, number | undefined> {
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
    ['diff', '--name-status', '--find-renames', '--diff-filter=R', base, 'HEAD', '--', '*.test.*'],
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

/**
 * The history-backed half: measured against the merge-base, not against the pin map, so
 * editing the map alongside the file cannot admit growth.
 */
function historyFindings(
  measured: ReadonlyMap<string, number>,
  pinned: Readonly<Record<string, number>>,
  baseLines: ReadonlyMap<string, number | undefined>,
  tripwire: number,
): string[] {
  const findings: string[] = [];
  for (const [file, lines] of [...measured].sort()) {
    if (lines <= tripwire) continue;
    const base = baseLines.get(file);
    if (base === undefined) {
      findings.push(
        `${file} is ${lines} lines and did not exist at the merge-base: a new test file may not cross the ${tripwire}-line tripwire, pinned or not.`,
      );
    } else if (lines > Math.max(base, tripwire)) {
      findings.push(
        `${file} is ${lines} lines, ${base} at the merge-base: a test file over the tripwire may not grow, whatever its pin says.`,
      );
    }
  }
  for (const [file, pin] of Object.entries(pinned).sort()) {
    const base = baseLines.get(file);
    if (base !== undefined && pin > base) {
      findings.push(
        `${file} is pinned at ${pin} but was ${base} lines at the merge-base: a pin may not be raised above its file's base length.`,
      );
    }
  }
  return findings;
}

test('no test file over the tripwire grows, and every pin matches its file exactly', () => {
  const measured = new Map<string, number>();
  for (const root of TEST_ROOTS) {
    for (const file of walkFiles(path.join(REPO_ROOT, root), isTestFile)) {
      measured.set(path.relative(REPO_ROOT, file).split(path.sep).join('/'), countLines(file));
    }
  }
  expect(measured.size).toBeGreaterThan(500);
  expect(ratchetFindings(measured, PINNED_TEST_FILE_LINES, TRIPWIRE_LINES)).toEqual([]);

  const ofInterest = [
    ...new Set([
      ...[...measured].filter(([, lines]) => lines > TRIPWIRE_LINES).map(([file]) => file),
      ...Object.keys(PINNED_TEST_FILE_LINES),
    ]),
  ];
  const baseLines = baseLineCounts(ofInterest);
  expect(historyFindings(measured, PINNED_TEST_FILE_LINES, baseLines, TRIPWIRE_LINES)).toEqual([]);
});

test('planted reds: growth, shrink, unpinned crossing, and a stale pin each name their fix', () => {
  const pinned = { 'a.test.ts': 1200, 'b.test.ts': 1500, 'e.test.ts': 900, 'gone.test.ts': 1100 };
  const measured = new Map([
    ['a.test.ts', 1201], // grew
    ['b.test.ts', 900], // shrank under the tripwire: the pin must go
    ['e.test.ts', 900], // unchanged sub-tripwire file that someone pinned at its own length
    ['c.test.ts', 1001], // new offender
    ['d.test.ts', 1000], // at the line, fine
  ]);
  expect(ratchetFindings(measured, pinned, 1000)).toEqual([
    'a.test.ts grew to 1201 lines (pinned 1200): extract instead of adding to a file over the tripwire.',
    'b.test.ts is 900 lines, at or under the 1000-line tripwire, but has a pin (1500): remove it — pins are only for files over the tripwire.',
    'c.test.ts is 1001 lines, over the 1000-line tripwire and not pinned: split it along the source module it mirrors (docs/agents/testing.md) rather than pinning it.',
    // The arbitrary-new-pin bypass: equality (900 == 900) and history (900 <= base) both pass,
    // so this rule is the one that rejects it.
    'e.test.ts is 900 lines, at or under the 1000-line tripwire, but has a pin (900): remove it — pins are only for files over the tripwire.',
    'gone.test.ts is pinned but does not exist: remove its pin.',
  ]);
  expect(ratchetFindings(new Map([['a.test.ts', 1200]]), { 'a.test.ts': 1200 }, 1000)).toEqual([]);
});

test('planted reds against history: raising a pin, growing into it, and pinning a new giant file are all red', () => {
  const baseLines = new Map<string, number | undefined>([
    ['a.test.ts', 1200], // existed, 1200 at base
    ['b.test.ts', 1500],
    ['fresh.test.ts', undefined], // did not exist at base
    ['small.test.ts', 900], // existed, under the tripwire at base
  ]);
  // Bypass 1: grow a pinned file and raise its pin so the equality pin stays green.
  expect(
    historyFindings(new Map([['a.test.ts', 1230]]), { 'a.test.ts': 1230 }, baseLines, 1000),
  ).toEqual([
    'a.test.ts is 1230 lines, 1200 at the merge-base: a test file over the tripwire may not grow, whatever its pin says.',
    "a.test.ts is pinned at 1230 but was 1200 lines at the merge-base: a pin may not be raised above its file's base length.",
  ]);
  // Raising the pin alone (before growing into it) is already red.
  expect(
    historyFindings(new Map([['a.test.ts', 1200]]), { 'a.test.ts': 1230 }, baseLines, 1000),
  ).toEqual([
    "a.test.ts is pinned at 1230 but was 1200 lines at the merge-base: a pin may not be raised above its file's base length.",
  ]);
  // Bypass 2: add a new >1,000-line file together with a pin for it.
  expect(
    historyFindings(new Map([['fresh.test.ts', 1400]]), { 'fresh.test.ts': 1400 }, baseLines, 1000),
  ).toEqual([
    'fresh.test.ts is 1400 lines and did not exist at the merge-base: a new test file may not cross the 1000-line tripwire, pinned or not.',
  ]);
  // Same for a file that existed but was under the tripwire at base.
  expect(
    historyFindings(new Map([['small.test.ts', 1001]]), { 'small.test.ts': 1001 }, baseLines, 1000),
  ).toEqual([
    'small.test.ts is 1001 lines, 900 at the merge-base: a test file over the tripwire may not grow, whatever its pin says.',
    "small.test.ts is pinned at 1001 but was 900 lines at the merge-base: a pin may not be raised above its file's base length.",
  ]);
  // Allowed: shrink with a lowered pin, a pin that disappears, an unchanged file.
  expect(
    historyFindings(
      new Map([
        ['a.test.ts', 1100],
        ['b.test.ts', 1500],
      ]),
      { 'a.test.ts': 1100, 'b.test.ts': 1500 },
      baseLines,
      1000,
    ),
  ).toEqual([]);
  expect(historyFindings(new Map([['a.test.ts', 950]]), {}, baseLines, 1000)).toEqual([]);
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
