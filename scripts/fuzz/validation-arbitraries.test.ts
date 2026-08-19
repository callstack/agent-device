// Generator-expectation gate for the validation fuzz targets (#1781 B2).
//
// A validation case asserts a specific outcome the generator planted, so a drifted generator is
// worse than a weak one: it would report phantom findings nightly (or mark real bugs expected).
// This suite replays fixed-seed samples against the real parsers in-process — every planted
// expectation must hold on a healthy tree, every mutation class must appear, and the planted
// violations must surface as validation-layer errors, past the tokenizer.

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { checkCase, describeFailure } from './invariant.ts';
import { getFuzzTarget } from './registry.ts';
import { decodeValidationCase } from './validation-case.ts';
import { cliValidationArb, maestroValidationArb } from './validation-arbitraries.ts';

// A mismatch that fires at ~1-in-1000 must not pass here and then phantom nightly: the nightly
// draws 38,000 cases per target, so this samples 7.9% of it rather than the 1.5% it began at.
const SAMPLE_SIZE = 3_000;
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

describe('planted violations surface where the generator says they do', () => {
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

  // The layer each class actually reaches, asserted rather than implied. `command-validation`
  // classes survive the argv scan and are refused by finalizeParsedArgs — the reach B2 adds.
  // `token-scan` classes are refused inside parseFlagValue while argv is still being scanned:
  // the layer the classic `cli-args` target already reaches. They stay for the error-code
  // assertion cli-args cannot make, and are not claimed as new reach anywhere.
  it.each([
    ['excess-positional', 'command-validation', /accepts at most \d+ positional argument/],
    ['unsupported-flag', 'command-validation', /is not supported for command/],
    ['unknown-command', 'command-validation', /^Unknown command:/],
    ['bad-enum-value', 'token-scan', /^Invalid /],
    ['int-out-of-range', 'token-scan', /^Invalid /],
    ['missing-flag-value', 'token-scan', /requires a value\./],
    ['boolean-with-value', 'token-scan', /does not take a value\./],
  ])('CLI %s is refused in %s', (mutation, _layer, expected) => {
    expect(rejectionMessageFor('cli-validation', mutation)).toMatch(expected);
  });

  it('spends most of the CLI budget on classes that survive the argv scan', () => {
    const sample = fc.sample(cliValidationArb, { numRuns: SAMPLE_SIZE, seed: SEED });
    const tokenScan = new Set([
      'bad-enum-value',
      'int-out-of-range',
      'missing-flag-value',
      'boolean-with-value',
    ]);
    const mutated = sample
      .map((input) => decodeValidationCase(input)!.mutation)
      .filter((mutation) => mutation !== 'valid');
    const scanned = mutated.filter((mutation) => tokenScan.has(mutation)).length;
    // Weighted down rather than removed, so the ratio is the lane's disclosed reach: a weight
    // edit that quietly hands the budget back to the token scan fails here.
    expect(scanned / mutated.length).toBeLessThan(0.25);
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

describe('generator startup', () => {
  // The eager version of this derivation charged every harness path the command-metadata
  // registry and timed out the coverage-instrumented promotion test. Importing must stay free.
  it('does not derive the CLI surface until a case is actually generated', async () => {
    vi.resetModules();
    const fresh = await import('./validation-arbitraries.ts');
    expect(fresh.validationSurfaceBuildCount()).toBe(0);
    fc.sample(fresh.cliValidationArb, { numRuns: 1, seed: SEED });
    expect(fresh.validationSurfaceBuildCount()).toBe(1);
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
