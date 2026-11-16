import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { maestroValidationArb } from '@agent-device/test-kit';
import { SUPPORTED_MAESTRO_COMMAND_NAMES } from './program-ir-command-parser.ts';

const sample = fc.sample(maestroValidationArb, { numRuns: 3_000, seed: 1 });

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
        const { payload } = JSON.parse(entry) as { payload: string | string[] };
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
