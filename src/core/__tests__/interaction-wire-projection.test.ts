import { describe, expect, test } from 'vitest';
import {
  interactionWireEchoFromInput,
  projectInteractionWireData,
} from '../interaction-wire-projection.ts';

describe('interaction wire projection', () => {
  test('omits default press repeat values', () => {
    expect(
      interactionWireEchoFromInput('press', {
        count: 1,
        intervalMs: 0,
        holdMs: 0,
        jitterPx: 0,
        doubleTap: false,
      }),
    ).toEqual({});
  });

  test('echoes non-default press repeat values', () => {
    expect(
      interactionWireEchoFromInput('press', {
        count: 2,
        intervalMs: 25,
        holdMs: 10,
        jitterPx: 1,
        doubleTap: true,
      }),
    ).toEqual({
      count: 2,
      intervalMs: 25,
      holdMs: 10,
      jitterPx: 1,
      doubleTap: true,
    });
  });

  test('echoes the normalized fill delay default', () => {
    expect(interactionWireEchoFromInput('fill', {})).toEqual({ delayMs: 0 });
  });

  test('preserves backend fields while deriving command echo defaults', () => {
    expect(
      projectInteractionWireData(
        'press',
        {},
        {
          count: 1,
          videoPath: '/tmp/demo.mp4',
        },
      ),
    ).toEqual({ videoPath: '/tmp/demo.mp4' });
  });

  test('removes default touch repeat echoes from fill backend data', () => {
    expect(
      projectInteractionWireData(
        'fill',
        {},
        {
          count: 1,
          delayMs: 0,
          doubleTap: false,
          holdMs: 0,
          intervalMs: 0,
          jitterPx: 0,
          text: 'Hello',
        },
      ),
    ).toEqual({ delayMs: 0, text: 'Hello' });
  });
});
