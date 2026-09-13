import { describe, expect, test } from 'vitest';
import { recordingHost, androidRecordingDevice } from './fixtures.ts';
import { readElapsedUptimeMs, recordingWindowMs } from './device-clock.ts';

describe('readElapsedUptimeMs', () => {
  test('reads the recorder clock from the device', async () => {
    const host = recordingHost({ elapsedUptimeMs: async () => 12_345 });
    const transport = await host.screenRecording.android.resolve(androidRecordingDevice);
    await expect(readElapsedUptimeMs(transport)).resolves.toBe(12_345);
  });

  test('gives up on a device that cannot answer', async () => {
    const host = recordingHost({
      elapsedUptimeMs: async () => {
        throw new Error('adb gone');
      },
    });
    const transport = await host.screenRecording.android.resolve(androidRecordingDevice);
    await expect(readElapsedUptimeMs(transport)).resolves.toBeUndefined();
  });
});

describe('recordingWindowMs', () => {
  test('measures recorder time between two reads of the device clock', () => {
    expect(recordingWindowMs({ stoppedUptimeMs: 20_000, startedUptimeMs: 12_345 })).toBe(7_655);
  });

  test('never reads a negative window out of a clock that went backwards', () => {
    expect(recordingWindowMs({ stoppedUptimeMs: 10_000, startedUptimeMs: 12_345 })).toBe(0);
  });

  test('stays unanswered when either read failed', () => {
    expect(
      recordingWindowMs({ stoppedUptimeMs: undefined, startedUptimeMs: 12_345 }),
    ).toBeUndefined();
    expect(
      recordingWindowMs({ stoppedUptimeMs: 20_000, startedUptimeMs: undefined }),
    ).toBeUndefined();
  });
});
