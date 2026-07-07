import { describe, expect, test } from 'vitest';
import { projectAppleRunnerWireResult } from '../runner/runner-result-projection.ts';

describe('projectAppleRunnerWireResult', () => {
  test('removes runner diagnostics while preserving public fields', () => {
    expect(
      projectAppleRunnerWireResult({
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
