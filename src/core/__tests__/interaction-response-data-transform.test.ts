import { describe, expect, test } from 'vitest';
import { resolveCommandResponseDataTransform } from '../command-descriptor/registry.ts';
import { transformInteractionResponseData } from '../interaction-response-data-transform.ts';

describe('interaction response data transform', () => {
  test('reads command-owned response data transform from descriptors', () => {
    expect(resolveCommandResponseDataTransform('press')?.fields).toEqual({
      count: { defaultValue: 1, omitDefault: true },
      intervalMs: { defaultValue: 0, omitDefault: true },
      holdMs: { defaultValue: 0, omitDefault: true },
      jitterPx: { defaultValue: 0, omitDefault: true },
      doubleTap: { defaultValue: false, omitDefault: true },
    });
    expect(resolveCommandResponseDataTransform('fill')?.fields.delayMs).toEqual({
      defaultValue: 0,
    });
    expect(resolveCommandResponseDataTransform('longpress')).toBeUndefined();
  });

  test('omits default press repeat values', () => {
    expect(
      transformInteractionResponseData({
        command: 'press',
        input: {
          count: 1,
          intervalMs: 0,
          holdMs: 0,
          jitterPx: 0,
          doubleTap: false,
        },
        data: undefined,
      }),
    ).toEqual({});
  });

  test('keeps non-default press repeat values', () => {
    expect(
      transformInteractionResponseData({
        command: 'press',
        input: {
          count: 2,
          intervalMs: 25,
          holdMs: 10,
          jitterPx: 1,
          doubleTap: true,
        },
        data: undefined,
      }),
    ).toEqual({
      count: 2,
      intervalMs: 25,
      holdMs: 10,
      jitterPx: 1,
      doubleTap: true,
    });
  });

  test('keeps the normalized fill delay default', () => {
    expect(
      transformInteractionResponseData({ command: 'fill', input: {}, data: undefined }),
    ).toEqual({
      delayMs: 0,
    });
  });

  test('preserves backend fields while applying command defaults', () => {
    expect(
      transformInteractionResponseData({
        command: 'press',
        input: {},
        data: {
          count: 1,
          videoPath: '/tmp/demo.mp4',
        },
      }),
    ).toEqual({ videoPath: '/tmp/demo.mp4' });
  });

  test('removes default touch repeat fields from fill backend data', () => {
    expect(
      transformInteractionResponseData({
        command: 'fill',
        input: {},
        data: {
          count: 1,
          delayMs: 0,
          doubleTap: false,
          holdMs: 0,
          intervalMs: 0,
          jitterPx: 0,
          text: 'Hello',
        },
      }),
    ).toEqual({ delayMs: 0, text: 'Hello' });
  });
});
