import { describe, expect, test } from 'vitest';
import { normalizeError } from '@agent-device/kernel/errors';
import { classifyAppleSimulatorRecordingExit } from './platform-runtime-screen-recording-apple-simulator-error.ts';

const BUSY_STDERR =
  'Error starting video recorder: Error Domain=NSPOSIXErrorDomain Code=16 "Resource busy"';

describe('classifyAppleSimulatorRecordingExit', () => {
  test('classifies the EBUSY exit and keeps the hint and reason through normalization', () => {
    const error = classifyAppleSimulatorRecordingExit({
      stdout: '',
      stderr: BUSY_STDERR,
      exitCode: 16,
    });

    expect(error?.code).toBe('COMMAND_FAILED');
    const normalized = normalizeError(error);
    expect(normalized.code).toBe('COMMAND_FAILED');
    expect(normalized.hint).toContain('SimStreamProcessorService');
    expect(normalized.details).toMatchObject({
      reason: 'apple-simulator-host-recording-busy',
      exitCode: 16,
      processExitError: true,
    });
    expect(normalized.message).toContain('CoreSimulator host recording slot is busy');
    expect(normalized.message).toContain('Resource busy');
  });

  test.each([1, 0, null])(
    'does not classify exit code %s as host-busy even with the identical busy stderr',
    (exitCode) => {
      expect(
        classifyAppleSimulatorRecordingExit({ stdout: '', stderr: BUSY_STDERR, exitCode }),
      ).toBeUndefined();
    },
  );
});
