// Expectation gate for the CLI validation generator (#1781 B2).
//
// A validation case asserts a specific outcome the generator planted, so a drifted generator is
// worse than a weak one: it would report phantom findings nightly (or mark real bugs expected).
// This replays fixed-seed samples against the real parser in-process — every planted expectation
// must hold on a healthy tree, every class must still fire, and each class must be refused in the
// parser layer it claims, so the lane's real reach stays disclosed rather than implied.

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { describeFailure } from './invariant.ts';
import { getFuzzTarget } from './registry.ts';
import { decodeValidationCase } from './validation-case.ts';
import { cliValidationArb } from './validation-arbitraries-cli.ts';

// A mismatch that fires at ~1-in-1000 must not pass here and then phantom nightly: the nightly
// draws 38,000 cases per target, so this samples 7.9% of it rather than the 1.5% it began at.
const SAMPLE_SIZE = 3_000;
const SEED = 1;

const target = getFuzzTarget('cli-validation');
const sample = fc.sample(cliValidationArb, { numRuns: SAMPLE_SIZE, seed: SEED });

describe('cli-validation generator', () => {
  it('is deterministic for a seed, so a reported counterexample replays', () => {
    const again = fc.sample(cliValidationArb, { numRuns: 32, seed: 7 });
    expect(again).toEqual(fc.sample(cliValidationArb, { numRuns: 32, seed: 7 }));
    expect(again).not.toEqual(fc.sample(cliValidationArb, { numRuns: 32, seed: 8 }));
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
    // A class that stops firing (surface drift, weight bug) is dead coverage and fails here.
    expect([...mutations].sort()).toMatchSnapshot();
  });
});

describe('planted CLI violations are refused where the generator says they are', () => {
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

  // `command-validation` classes survive the argv scan and reach finalizeParsedArgs — the reach
  // these targets add. `token-scan` classes are refused inside parseFlagValue while argv is still
  // being scanned: the layer the classic `cli-args` target already reaches, kept here for the
  // error-code assertion cli-args cannot make and never claimed as new reach.
  it.each([
    ['excess-positional', 'command-validation', /accepts at most \d+ positional argument/],
    ['unsupported-flag', 'command-validation', /is not supported for command/],
    ['unknown-command', 'command-validation', /^Unknown command:/],
    ['bad-enum-value', 'token-scan', /^Invalid /],
    ['int-out-of-range', 'token-scan', /^Invalid /],
    ['missing-flag-value', 'token-scan', /requires a value\./],
    ['boolean-with-value', 'token-scan', /does not take a value\./],
  ])('%s is refused in %s', (mutation, _layer, expected) => {
    expect(rejectionMessageFor(mutation)).toMatch(expected);
  });

  it('spends most of the budget on classes that survive the argv scan', () => {
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
});

describe('generator startup', () => {
  // The eager version of this derivation charged every harness path the command-metadata registry
  // and timed out the coverage-instrumented promotion test (#1824). Importing must stay free.
  it('does not derive the CLI surface until a case is actually generated', async () => {
    vi.resetModules();
    const fresh = await import('./validation-arbitraries-cli.ts');
    expect(fresh.validationSurfaceBuildCount()).toBe(0);
    fc.sample(fresh.cliValidationArb, { numRuns: 1, seed: SEED });
    expect(fresh.validationSurfaceBuildCount()).toBe(1);
  });
});
