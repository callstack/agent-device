import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { maestroValidationArb } from '@agent-device/test-kit';
import { SUPPORTED_MAESTRO_COMMAND_NAMES } from './program-ir-command-parser.ts';

const sample = fc.sample(maestroValidationArb, { numRuns: 3_000, seed: 1 });

function coversCommand(line: string, command: string): boolean {
  const trimmed = line.trim();
  return trimmed === `- ${command}` || trimmed.startsWith(`- ${command}:`);
}

describe('shape coverage against the converter', () => {
  it('does not count invalid command-name prefixes as coverage', () => {
    expect(coversCommand('- tapOnPoint: 10,20', 'tapOn')).toBe(false);
    expect(coversCommand('- inputTextt: Login', 'inputText')).toBe(false);
    expect(coversCommand('- tapOn: Login', 'tapOn')).toBe(true);
    expect(coversCommand('  - back', 'back')).toBe(true);
  });

  it('emits every command the converter supports', () => {
    const emitted = new Set(
      sample.flatMap((entry) => {
        const { payload } = JSON.parse(entry) as { payload: string | string[] };
        return typeof payload === 'string' ? payload.split('\n') : [];
      }),
    );
    const covered = (command: string) =>
      [...emitted].some((line) => coversCommand(line, command));
    const missing = SUPPORTED_MAESTRO_COMMAND_NAMES.filter(
      (command) => !covered(command),
    );
    expect(missing).toEqual([]);
  });
});
