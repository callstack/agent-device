// Unit-lane replay of the parser fuzz regression corpus (#1414).
//
// The nightly lane finds cases; this replays every case it ever found, in-process and
// without a watchdog, so a regression fails in seconds on a PR instead of a night later.
// Cases run synchronously here on purpose: a corpus case that hangs would hang the unit
// suite, which is exactly the signal (the nightly lane is where hangs are diagnosed).

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arbitraryForTarget } from './arbitraries.ts';
import { readCorpus } from './corpus.ts';
import { checkCase } from './invariant.ts';
import { getFuzzTarget } from './registry.ts';
import { FUZZ_TARGETS } from './targets.ts';

describe('parser fuzz regression corpus', () => {
  const corpus = readCorpus();

  // The batch-steps parser warns on deprecated step shapes; replaying those cases would
  // print one warning line per case into the unit-suite output.
  beforeEach(() => void vi.spyOn(process.stderr, 'write').mockReturnValue(true));
  afterEach(() => void vi.restoreAllMocks());

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

  it.each(corpus.map((entry, index) => [index, entry] as const))(
    'case %i holds the typed-AppError invariant',
    (_index, entry) => {
      expect(checkCase(getFuzzTarget(entry.target), entry.input)).toBeNull();
    },
  );

  it.each(FUZZ_TARGETS.map((target) => [target.name, target] as const))(
    '%s seeds hold the invariant',
    (_name, target) => {
      for (const seed of target.seeds) expect(checkCase(target, seed)).toBeNull();
    },
  );
});

describe('fuzz case generation', () => {
  const target = getFuzzTarget('selector');

  it('is deterministic for a seed, so a reported counterexample replays', () => {
    const sample = (seed: number) => fc.sample(arbitraryForTarget(target), { numRuns: 32, seed });
    expect(sample(7)).toEqual(sample(7));
    expect(sample(7)).not.toEqual(sample(8));
  });

  it('generates strings the target can be fed directly', () => {
    for (const input of fc.sample(arbitraryForTarget(target), { numRuns: 64, seed: 1 })) {
      expect(typeof input).toBe('string');
      expect(checkCase(target, input)).toBeNull();
    }
  });
});
