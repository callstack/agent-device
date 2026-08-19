// Expectation gate for the Maestro validation generator (#1781 B2).
//
// The Maestro shapes are rendered by hand rather than derived from a registry, so this file is
// the only thing standing between a drifted shape and a nightly full of phantom findings: it
// replays fixed-seed samples against the real parser and requires every planted expectation to
// hold, every class to fire, and the violations to be refused in command-shape validation rather
// than by the YAML tokenizer.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_MAESTRO_COMMAND_NAMES } from '../../packages/maestro/src/internal/program-ir-command-parser.ts';
import { getFuzzTarget } from './registry.ts';
import { decodeValidationCase } from './validation-case.ts';
import { describeGeneratorContract } from './validation-generator-contract.ts';
import { MAESTRO_MUTATION_NAMES, maestroValidationArb } from './validation-arbitraries-maestro.ts';

const SAMPLE_SIZE = 3_000;
const SEED = 1;

const target = getFuzzTarget('maestro-validation');
const sample = fc.sample(maestroValidationArb, { numRuns: SAMPLE_SIZE, seed: SEED });

describeGeneratorContract({
  targetName: 'maestro-validation',
  arbitrary: maestroValidationArb,
  declaredClasses: MAESTRO_MUTATION_NAMES,
  sample,
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

describe('shape coverage against the converter', () => {
  // The valid Maestro shapes are rendered by hand here, so the one thing that cannot be left to
  // drift is which commands they cover: a command the converter accepts but this generator never
  // emits is a hole the nightly cannot see. Waivers are explicit and must say why.
  const NOT_GENERATED = new Set([
    // Both take a nested command list whose bodies the repeat/runFlow cases already cover.
    'retry',
    // Needs a JS file on disk to resolve, which a generated case has no way to provide.
    'runScript',
  ]);

  it('emits every command the converter supports, or waives it explicitly', () => {
    const emitted = new Set(
      sample.flatMap((entry) => {
        const { payload } = decodeValidationCase(entry)!;
        return typeof payload === 'string' ? payload.split('\n') : [];
      }),
    );
    const covered = (command: string) =>
      [...emitted].some((line) => line.trim().startsWith(`- ${command}`));
    const missing = SUPPORTED_MAESTRO_COMMAND_NAMES.filter(
      (command) => !NOT_GENERATED.has(command) && !covered(command),
    );
    expect(missing).toEqual([]);
  });
});
