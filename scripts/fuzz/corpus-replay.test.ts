// Unit-lane replay of the parser fuzz regression corpus (#1414).
//
// The nightly lane finds cases; this replays every case it ever found so a regression fails in
// seconds on a PR instead of a night later. Cases go through the same worker-backed watchdog the
// nightly lane uses, and for the same reason they run in a worker *process* (#2053): a promoted
// hang case must fail this test against its per-case budget rather than wedge the unit job, and
// a case that faults the process it runs in must fail this test rather than kill the Vitest
// worker running it — which reports no test, no file, and no case.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbitraryForTarget } from './arbitraries.ts';
import { readCorpus } from './corpus.ts';
import { runCases } from './execute.ts';
import { describeFailure } from './invariant.ts';
import { getFuzzTarget } from './registry.ts';
import { FUZZ_TARGETS } from './targets.ts';

/**
 * Generous enough that a loaded CI runner never reports a healthy parser as hung, small enough
 * that a genuinely wedged case fails the file in seconds.
 */
const CASE_TIMEOUT_MS = 5_000;

/**
 * Vitest must outlast the watchdog for every case a test replays, or a wedged parser is reported as
 * a bare `Test timed out` instead of the named `hang:` failure that says which input wedged.
 */
const timeoutFor = (cases: number) => cases * CASE_TIMEOUT_MS + 10_000;

describe('parser fuzz regression corpus', () => {
  const corpus = readCorpus();

  it('is non-empty and free of duplicates', () => {
    expect(corpus.length).toBeGreaterThan(0);
    const keys = corpus.map((entry) => `${entry.target}\u0000${entry.input}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('names only real parser targets and explains every entry', () => {
    const parserTargets = new Set<string>(FUZZ_TARGETS.map((target) => target.name));
    for (const entry of corpus) {
      expect(parserTargets).toContain(entry.target);
      expect(entry.note.trim()).not.toBe('');
    }
  });

  // One worker per target rather than per case: startup is the only real cost here, and the
  // watchdog budget is per case either way.
  it.each(FUZZ_TARGETS.map((target) => [target.name, target] as const))(
    '%s corpus cases and seeds hold the invariant, under the watchdog',
    async (name, target) => {
      const cases = [
        ...target.seeds,
        ...corpus.filter((entry) => entry.target === name).map((entry) => entry.input),
      ];
      const failures = await runCases(target, cases, CASE_TIMEOUT_MS);
      expect(failures.map(describeFailure)).toEqual([]);
    },
    timeoutFor(corpus.length + Math.max(...FUZZ_TARGETS.map((t) => t.seeds.length))),
  );
});

describe('fuzz case generation', () => {
  const target = getFuzzTarget('selector');

  it('is deterministic for a seed, so a reported counterexample replays', () => {
    const sample = (seed: number) => fc.sample(arbitraryForTarget(target), { numRuns: 32, seed });
    expect(sample(7)).toEqual(sample(7));
    expect(sample(7)).not.toEqual(sample(8));
  });

  const GENERATED_CASES = 64;

  it(
    'generates strings the target can be fed directly',
    async () => {
      const inputs = fc.sample(arbitraryForTarget(target), { numRuns: GENERATED_CASES, seed: 1 });
      expect(inputs.every((input) => typeof input === 'string')).toBe(true);
      const failures = await runCases(target, inputs, CASE_TIMEOUT_MS);
      expect(failures.map(describeFailure)).toEqual([]);
    },
    timeoutFor(GENERATED_CASES),
  );
});
