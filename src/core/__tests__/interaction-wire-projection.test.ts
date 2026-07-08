import { describe, expect, test } from 'vitest';
import {
  interactionWireEchoFromInput,
  projectInteractionWireData,
} from '../interaction-wire-projection.ts';
import { resolveCommandWireProjection } from '../command-descriptor/registry.ts';

describe('interaction wire projection', () => {
  test('reads command-owned wire echo specs from descriptors', () => {
    expect(resolveCommandWireProjection('press')?.wireEcho).toEqual({
      count: { defaultValue: 1, mode: 'omit-default' },
      intervalMs: { defaultValue: 0, mode: 'omit-default' },
      holdMs: { defaultValue: 0, mode: 'omit-default' },
      jitterPx: { defaultValue: 0, mode: 'omit-default' },
      doubleTap: { defaultValue: false, mode: 'omit-default' },
    });
    expect(resolveCommandWireProjection('fill')?.wireEcho.delayMs).toEqual({ defaultValue: 0 });
    expect(resolveCommandWireProjection('longpress')).toBeUndefined();
  });

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
