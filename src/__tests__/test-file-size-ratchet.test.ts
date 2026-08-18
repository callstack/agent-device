import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { walkFiles } from '../../scripts/lib/walk-files.ts';

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
 * Catches: a >1,000-line test file growing, or a new one appearing.
 * Evidence: 26 test files were over the line when this landed (2026-08-18); the largest,
 *   `snapshot-handler.test.ts`, gained 55 lines in the PR before, under a rule with no gate.
 * Cost: one directory walk and a line count per test file — well under a second.
 * Kill criterion: the pin list is empty. Delete this file with the last pin.
 */

const TRIPWIRE_LINES = 1_000;

// Exact current lengths. Lower a pin when its file shrinks; never raise one — extract instead.
const PINNED_TEST_FILE_LINES: Readonly<Record<string, number>> = Object.freeze({
  'src/__tests__/remote-connection.test.ts': 2973,
  'src/daemon/handlers/__tests__/snapshot-handler.test.ts': 2652,
  'src/commands/interaction/runtime/settle.test.ts': 2361,
  'src/platforms/apple/core/__tests__/runner-session.test.ts': 2083,
  'src/daemon/handlers/__tests__/session-replay-runtime-maestro.test.ts': 2031,
  'src/utils/__tests__/daemon-client.test.ts': 1910,
  'src/utils/__tests__/output.test.ts': 1861,
  'src/platforms/android/__tests__/snapshot.test.ts': 1636,
  'src/platforms/apple/core/__tests__/runner-client.test.ts': 1615,
  'src/__tests__/client.test.ts': 1598,
  'test/integration/provider-scenarios/android-lifecycle.test.ts': 1597,
  'src/utils/__tests__/daemon-client-lifecycle.test.ts': 1414,
  'src/platforms/apple/core/__tests__/runner-command-retry.test.ts': 1327,
  'src/__tests__/cli-client-commands.test.ts': 1317,
  'src/__tests__/cli-config.test.ts': 1282,
  'src/daemon/handlers/__tests__/find.test.ts': 1237,
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
    if (lines > pin) {
      findings.push(
        `${file} grew to ${lines} lines (pinned ${pin}): extract instead of adding to a file over the tripwire.`,
      );
    } else if (lines < pin) {
      findings.push(
        `${file} shrank to ${lines} lines (pinned ${pin}): lower its pin in this PR so the ratchet keeps the gain` +
          (lines <= tripwire ? ' — it is now under the tripwire, so remove the pin.' : '.'),
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

test('no test file over the tripwire grows, and every pin matches its file exactly', () => {
  const measured = new Map<string, number>();
  for (const root of TEST_ROOTS) {
    for (const file of walkFiles(path.join(REPO_ROOT, root), isTestFile)) {
      measured.set(path.relative(REPO_ROOT, file).split(path.sep).join('/'), countLines(file));
    }
  }
  expect(measured.size).toBeGreaterThan(500);
  expect(ratchetFindings(measured, PINNED_TEST_FILE_LINES, TRIPWIRE_LINES)).toEqual([]);
});

test('planted reds: growth, shrink, unpinned crossing, and a stale pin each name their fix', () => {
  const pinned = { 'a.test.ts': 1200, 'b.test.ts': 1500, 'gone.test.ts': 1100 };
  const measured = new Map([
    ['a.test.ts', 1201], // grew
    ['b.test.ts', 900], // shrank under the tripwire
    ['c.test.ts', 1001], // new offender
    ['d.test.ts', 1000], // at the line, fine
  ]);
  expect(ratchetFindings(measured, pinned, 1000)).toEqual([
    'a.test.ts grew to 1201 lines (pinned 1200): extract instead of adding to a file over the tripwire.',
    'b.test.ts shrank to 900 lines (pinned 1500): lower its pin in this PR so the ratchet keeps the gain — it is now under the tripwire, so remove the pin.',
    'c.test.ts is 1001 lines, over the 1000-line tripwire and not pinned: split it along the source module it mirrors (docs/agents/testing.md) rather than pinning it.',
    'gone.test.ts is pinned but does not exist: remove its pin.',
  ]);
  expect(ratchetFindings(new Map([['a.test.ts', 1200]]), { 'a.test.ts': 1200 }, 1000)).toEqual([]);
});
