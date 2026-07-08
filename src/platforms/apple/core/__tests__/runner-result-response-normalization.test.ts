import { describe, expect, test } from 'vitest';
import { normalizeAppleRunnerResultForResponse } from '../runner/runner-result-response-normalization.ts';

describe('normalizeAppleRunnerResultForResponse', () => {
  test('removes runner diagnostics while preserving public fields', () => {
    expect(
      normalizeAppleRunnerResultForResponse({
        completedSteps: 2,
        count: 1,
        currentUptimeMs: 123,
        gestureEndUptimeMs: 456,
        gestureStartUptimeMs: 100,
        sequenceResults: [{ ok: true }],
        videoPath: '/tmp/demo.mp4',
      }),
    ).toEqual({
      completedSteps: 2,
      count: 1,
      videoPath: '/tmp/demo.mp4',
    });
  });
});
