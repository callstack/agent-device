/**
 * `--test-ime` / `--no-test-ime` parsing across the three surfaces that accept it (#2997).
 * Split out of `args-parse-session.test.ts`, which sits at the 1,000-line test-size
 * tripwire (AGENTS.md "Module and test topology").
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseArgs } from '../args.ts';

const scenarios: Array<{
  label: string;
  argv: string[];
  assertParsed: (parsed: ReturnType<typeof parseArgs>) => void;
}> = [
  {
    label: 'open --test-ime forces the Android test IME on',
    argv: ['open', 'settings', '--platform', 'android', '--test-ime'],
    assertParsed: (parsed) => {
      assert.equal(parsed.command, 'open');
      assert.equal(parsed.flags.testIme, true);
    },
  },
  {
    label: 'open --no-test-ime forces the Android test IME off',
    argv: ['open', 'settings', '--platform', 'android', '--no-test-ime'],
    assertParsed: (parsed) => {
      assert.equal(parsed.command, 'open');
      assert.equal(parsed.flags.testIme, false);
    },
  },
  {
    label: 'test --test-ime opts the suite session opens into the Android test IME',
    argv: ['test', './suite.ad', '--test-ime'],
    assertParsed: (parsed) => {
      assert.equal(parsed.command, 'test');
      assert.equal(parsed.flags.testIme, true);
    },
  },
  {
    label: 'replay --no-test-ime forces the real keyboard for the replay sessions',
    argv: ['replay', './flow.ad', '--no-test-ime'],
    assertParsed: (parsed) => {
      assert.equal(parsed.command, 'replay');
      assert.equal(parsed.flags.testIme, false);
    },
  },
];

test('parseArgs admits --test-ime on every surface that accepts it', async () => {
  for (const scenario of scenarios) {
    const parsed = parseArgs(scenario.argv, { strictFlags: true });
    scenario.assertParsed(parsed);
  }
});
