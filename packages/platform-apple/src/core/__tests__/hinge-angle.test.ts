import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../tool-provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tool-provider.ts')>();
  return { ...actual, runXcrun: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })) };
});

import { parseHingeAngleSample, readAppleHingeAngle } from '../hinge-angle.ts';
import { runXcrun } from '../tool-provider.ts';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

const mockRunXcrun = vi.mocked(runXcrun);

/** Verbatim stream output from a comma-decimal host, including the self-abort devicectl ends on. */
const STREAM_OUTPUT = `Hinge angle monitoring started. 1 seconds remaining:
• +0,000s : Angle:180,0°  Mech:180,0°  Velocity:+0,0°/s  AngleValid:Y  VelocityValid:N  Range:0-180°
ERROR: Command timeout of 5.0 seconds exceeded. Assuming command got stuck and aborting.
`;

beforeEach(() => {
  mockRunXcrun.mockReset();
});

test('parses the human sample line under comma and dot decimal locales', () => {
  expect(parseHingeAngleSample(STREAM_OUTPUT)).toBe(180);
  // A hinge moving during the stream prints several samples; the last one is where it is now.
  expect(
    parseHingeAngleSample(
      '• +0,000s : Angle:175,1°  Mech:175,1°\n• +2,100s : Angle:140,0°  Mech:140,0°\n• +4,000s : Angle:130,0°  Mech:130,0°\n',
    ),
  ).toBe(130);
  expect(parseHingeAngleSample('• +0.000s : Angle:  0.0°  Mech:  0.0°')).toBe(0);
  expect(parseHingeAngleSample('• +0,000s : Angle: 95,7°  Mech: 95,7°')).toBe(95.7);
  expect(parseHingeAngleSample('Hinge angle monitoring started.')).toBeUndefined();
});

test('bounds the stream with the smallest devicectl timeout and reads the sample it printed', async () => {
  // Exit code 2 is the deadline devicectl set for itself, not a failure of the read.
  mockRunXcrun.mockResolvedValueOnce({ exitCode: 2, stdout: STREAM_OUTPUT, stderr: '' });

  await expect(readAppleHingeAngle(IOS_TEST_SIMULATOR)).resolves.toBe(180);

  expect(mockRunXcrun).toHaveBeenCalledWith(
    [
      'devicectl',
      'device',
      'motion',
      'hinge-angle',
      '--device',
      IOS_TEST_SIMULATOR.id,
      '--session-timeout',
      '1',
      '--timeout',
      '5',
    ],
    expect.objectContaining({ allowFailure: true, timeoutMs: 20_000 }),
  );
});

test('refuses a stream that printed no sample, naming the toolchain gap', async () => {
  mockRunXcrun.mockResolvedValueOnce({
    exitCode: 1,
    stdout: '',
    stderr: 'ERROR: Hinge angle monitoring is not available on this device.',
  });

  await expect(readAppleHingeAngle(IOS_TEST_SIMULATOR)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: expect.objectContaining({ hint: expect.stringContaining('hinge-angle') }),
  });
});
