// Expectation gate for the Maestro validation generator (#1781 B2).
//
// The Maestro shapes are rendered by hand rather than derived from a registry, so this file is
// the only thing standing between a drifted shape and a nightly full of phantom findings: it
// replays fixed-seed samples against the real parser and requires every planted expectation to
// hold, every class to fire, and the violations to be refused in command-shape validation rather
// than by the YAML tokenizer.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { describeFailure } from './invariant.ts';
import { getFuzzTarget } from './registry.ts';
import { decodeValidationCase } from './validation-case.ts';
import { maestroValidationArb } from './validation-arbitraries-maestro.ts';

const SAMPLE_SIZE = 3_000;
const SEED = 1;

const target = getFuzzTarget('maestro-validation');
const sample = fc.sample(maestroValidationArb, { numRuns: SAMPLE_SIZE, seed: SEED });

describe('maestro-validation generator', () => {
  it('is deterministic for a seed, so a reported counterexample replays', () => {
    const again = fc.sample(maestroValidationArb, { numRuns: 32, seed: 7 });
    expect(again).toEqual(fc.sample(maestroValidationArb, { numRuns: 32, seed: 7 }));
    expect(again).not.toEqual(fc.sample(maestroValidationArb, { numRuns: 32, seed: 8 }));
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
    expect([...mutations].sort()).toMatchSnapshot();
  });
});

describe('planted Maestro violations are refused by command-shape validation', () => {
  function rejectionMessageFor(mutation: string): string {
    const input = sample.find((entry) => decodeValidationCase(entry)!.mutation === mutation);
    expect(input, `no ${mutation} case in the fixed-seed sample`).toBeDefined();
    const decoded = decodeValidationCase(input!)!;
    try {
      target.run(input!);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error(`expected ${mutation} case to reject: ${JSON.stringify(decoded.payload)}`);
  }

  it('unknown commands die in command-shape validation, not the YAML tokenizer', () => {
    expect(rejectionMessageFor('unsupported-command')).toMatch(
      /Maestro command ".+" is not supported/,
    );
  });

  it('unknown fields die in per-command field validation', () => {
    expect(rejectionMessageFor('unsupported-field')).toMatch(/field ".+" is not supported/);
  });

  it('unknown config keys die in flow-config validation', () => {
    expect(rejectionMessageFor('config-unknown-key')).toMatch(
      /Maestro flow config field ".+" is not supported/,
    );
  });
});
