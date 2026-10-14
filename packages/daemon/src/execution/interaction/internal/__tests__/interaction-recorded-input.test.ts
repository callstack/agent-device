import { expect, test } from 'vitest';
import type { CommandFlags } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { assertRecordedFillParameterization } from '../interaction-recorded-input.ts';

function check(flags: CommandFlags, isSessionRecording: boolean): void {
  assertRecordedFillParameterization({ flags, replayPlanStep: false, isSessionRecording });
}

test('a stdin fill is refused while recording is armed unless the caller says how to script it', () => {
  let caught: unknown;
  try {
    check({ textStdin: true }, true);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe('INVALID_ARGS');
  expect((caught as AppError).details?.reason).toBe('fill_text_stdin_unparameterized_recording');
});

test.each([
  ['--record-as while recording', { textStdin: true, recordAs: 'PASSWORD' }, true],
  ['--no-record while recording', { textStdin: true, noRecord: true }, true],
  ['no armed recording', { textStdin: true }, false],
])('a stdin fill is admitted with %s', (_name, flags, isSessionRecording) => {
  expect(() => check(flags, isSessionRecording)).not.toThrow();
});

test('--record-as keeps requiring an armed recording when the text came from stdin', () => {
  expect(() => check({ textStdin: true, recordAs: 'PASSWORD' }, false)).toThrow(
    /requires an armed script recording/,
  );
});
