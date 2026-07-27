// Unit-lane replay of the parser fuzz regression corpus (#1414).
//
// The nightly lane finds cases; this replays every case it ever found, in-process and
// without a watchdog, so a regression fails in seconds on a PR instead of a night later.
// Cases run synchronously here on purpose: a corpus case that hangs would hang the unit
// suite, which is exactly the signal (the nightly lane is where hangs are diagnosed).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCorpus } from './corpus.ts';
import { checkCase } from './invariant.ts';
import { FUZZ_TARGETS, getFuzzTarget } from './targets.ts';
import { generateCases } from './mutate.ts';

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

  it('names only known targets and explains every entry', () => {
    for (const entry of corpus) {
      expect(() => getFuzzTarget(entry.target)).not.toThrow();
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
  it('is deterministic for a seed, so a repro command reproduces', () => {
    const seeds = ['text=Login', 'label="Sign in" && role=button'];
    expect(generateCases(seeds, 32, 7)).toEqual(generateCases(seeds, 32, 7));
    expect(generateCases(seeds, 32, 7)).not.toEqual(generateCases(seeds, 32, 8));
  });

  it('always covers the verbatim seeds before mutating', () => {
    const seeds = ['a', 'b', 'c'];
    expect(generateCases(seeds, 1, 1)).toEqual(seeds);
    expect(generateCases(seeds, 10, 1).slice(0, 3)).toEqual(seeds);
  });
});
