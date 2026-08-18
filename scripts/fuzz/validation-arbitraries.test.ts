// Generator-expectation gate for the validation fuzz targets (#1781 B2).
//
// A validation case asserts a specific outcome the generator planted, so a drifted generator is
// worse than a weak one: it would report phantom findings nightly (or mark real bugs expected).
// This suite replays fixed-seed samples against the real parsers in-process — every planted
// expectation must hold on a healthy tree, every mutation class must appear, and the planted
// violations must surface as validation-layer errors, past the tokenizer.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkCase, describeFailure } from './invariant.ts';
import { getFuzzTarget } from './registry.ts';
import { decodeValidationCase } from './validation-case.ts';
import { cliValidationArb, maestroValidationArb } from './validation-arbitraries.ts';

const SAMPLE_SIZE = 500;
const SEED = 1;

const TARGETS = [
  ['cli-validation', cliValidationArb],
  ['maestro-validation', maestroValidationArb],
] as const;

describe.each(TARGETS)('%s generator', (targetName, arbitrary) => {
  const target = getFuzzTarget(targetName);
  const sample = fc.sample(arbitrary, { numRuns: SAMPLE_SIZE, seed: SEED });

  it('is deterministic for a seed, so a reported counterexample replays', () => {
    const again = fc.sample(arbitrary, { numRuns: 32, seed: 7 });
    expect(again).toEqual(fc.sample(arbitrary, { numRuns: 32, seed: 7 }));
    expect(again).not.toEqual(fc.sample(arbitrary, { numRuns: 32, seed: 8 }));
  });

  it('produces decodable envelopes whose expectations hold on a healthy tree', () => {
    const failures = [];
    for (const input of sample) {
      expect(decodeValidationCase(input)).not.toBeNull();
      const failure = target.check!(input);
      if (failure) failures.push(describeFailure(failure));
    }
    expect(failures).toEqual([]);
  });

  it('exercises every mutation class, including valid accept cases', () => {
    const mutations = new Set(sample.map((input) => decodeValidationCase(input)!.mutation));
    expect(mutations).toContain('valid');
    // Every rule the generator declares shows up in a nightly-scale slice of the space; a rule
    // that stops firing (surface drift, weight bug) is dead coverage and fails here.
    expect([...mutations].sort()).toMatchSnapshot();
  });
});

describe('planted violations surface past the tokenizer', () => {
  function rejectionMessageFor(targetName: (typeof TARGETS)[number][0], mutation: string): string {
    const arbitrary = targetName === 'cli-validation' ? cliValidationArb : maestroValidationArb;
    const sample = fc.sample(arbitrary, { numRuns: SAMPLE_SIZE, seed: SEED });
    const input = sample.find((entry) => decodeValidationCase(entry)!.mutation === mutation);
    expect(input, `no ${mutation} case in the fixed-seed sample`).toBeDefined();
    const decoded = decodeValidationCase(input!)!;
    const target = getFuzzTarget(targetName);
    try {
      target.run(input!);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error(`expected ${mutation} case to reject: ${JSON.stringify(decoded.payload)}`);
  }

  it('CLI excess positionals die in positional-arity validation (#1433)', () => {
    expect(rejectionMessageFor('cli-validation', 'excess-positional')).toMatch(
      /accepts at most \d+ positional argument/,
    );
  });

  it('CLI enum violations die in flag-value validation', () => {
    expect(rejectionMessageFor('cli-validation', 'bad-enum-value')).toMatch(/^Invalid /);
  });

  it('CLI unsupported flags die in per-command flag support validation', () => {
    expect(rejectionMessageFor('cli-validation', 'unsupported-flag')).toMatch(
      /is not supported for command/,
    );
  });

  it('Maestro unknown commands die in command-shape validation, not the YAML tokenizer', () => {
    expect(rejectionMessageFor('maestro-validation', 'unsupported-command')).toMatch(
      /Maestro command ".+" is not supported/,
    );
  });

  it('Maestro unknown fields die in per-command field validation', () => {
    expect(rejectionMessageFor('maestro-validation', 'unsupported-field')).toMatch(
      /field ".+" is not supported/,
    );
  });
});

describe('validation envelope guard', () => {
  it('reports a malformed envelope as a finding instead of crashing the worker', () => {
    const target = getFuzzTarget('cli-validation');
    const failure = checkCase(target, 'not an envelope');
    expect(failure?.kind).toBe('untyped-throw');
    expect(failure?.detail).toContain('malformed validation case envelope');
  });
});
